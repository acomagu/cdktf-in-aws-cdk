import * as s3 from '@aws-sdk/client-s3';
import type * as AWSLambda from 'aws-lambda';
import * as childProcess from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as unzipper from 'unzipper';

export interface OnEventRequest extends AWSLambda.CloudFormationCustomResourceEventCommon {
  /**
   * The request type is set by the AWS CloudFormation stack operation
   * (create-stack, update-stack, or delete-stack) that was initiated by the
   * template developer for the stack that contains the custom resource.
   */
  readonly RequestType: 'Create' | 'Update' | 'Delete';

  /**
   * Used only for Update requests. Contains the resource properties that were
   * declared previous to the update request.
   */
  readonly OldResourceProperties?: { [key: string]: any };

  /**
   * A required custom resource provider-defined physical ID that is unique for
   * that provider.
   *
   * Always sent with 'Update' and 'Delete' requests; never sent with 'Create'.
   */
  readonly PhysicalResourceId?: string;
}

/**
 * The object returned from the user-defined `onEvent` handler.
 */
interface OnEventResponse {
  /**
   * A required custom resource provider-defined physical ID that is unique for
   * that provider.
   *
   * In order to reduce the chance for mistakes, all event types MUST return
   * with `PhysicalResourceId`.
   *
   * - For `Create`, this will be the user-defined or generated physical
   *   resource ID.
   * - For `Update`, if the returned PhysicalResourceId is different value from
   *   the current one, it means that the old physical resource needs to be
   *   deleted, and CloudFormation will immediately send a `Delete` event with
   *   the old physical ID.
   * - For `Delete`, this must be the same value received in the event.
   *
   * @default - for "Create" requests, defaults to the event's RequestId, for
   * "Update" and "Delete", defaults to the current `PhysicalResourceId`.
   */
  readonly PhysicalResourceId?: string;

  /**
   * Resource attributes to return.
   */
  readonly Data?: { [name: string]: any };

  /**
   * Custom fields returned from OnEvent will be passed to IsComplete.
   */
  readonly [key: string]: any;

  /**
   * Whether to mask the output of the custom resource when retrieved
   * by using the `Fn::GetAtt` function. If set to `true`, all returned
   * values are masked with asterisks (*****).
   *
   * @default false
   */
  readonly NoEcho?: boolean;
}

const s3Client = new s3.S3({});

export async function handler(ev: OnEventRequest): Promise<OnEventResponse> {
  console.log(ev.ResourceProperties);

  try {
    const dir = fs.mkdtempSync('/tmp/deploy');

    const stackAssetsFile = await unzipper.Open.s3_v3(s3Client, {
      Bucket: ev.ResourceProperties.TFStackAssetsBucketName,
      Key: ev.ResourceProperties.TFStackAssetsObjectKey,
    });
    await stackAssetsFile.extract({
      path: path.join(dir, 'assets'),
    });

    try {
      fs.writeFileSync(path.join(dir, 'terraform.tfvars.json'), JSON.stringify(ev.ResourceProperties.Variables));
      fs.writeFileSync(path.join(dir, 'main.tf.json'), JSON.stringify(ev.ResourceProperties.Terraform));

      switch (ev.RequestType) {
        case 'Create':
        case 'Update':
          await exec(path.join(import.meta.dirname, './terraform'), [
            'init',
            '--input=false',
            `--backend-config=bucket=${ev.ResourceProperties.S3BackendBucket}`,
            `--backend-config=region=${ev.ResourceProperties.S3BackendBucketRegion}`,
            '--backend-config=key=tfstate',
          ], { cwd: dir });

          try {
            await exec(path.join(import.meta.dirname, './terraform'), [
              'apply',
              '--auto-approve',
              '--input=false',
            ], { cwd: dir });

            const { stdout: terraformOutputJson } = await exec(path.join(import.meta.dirname, './terraform'), [
              'output',
              '--json',
            ], { cwd: dir });
            const terraformOutput = JSON.parse(terraformOutputJson);

            return {
              Data: Object.fromEntries(Object.entries(terraformOutput).map(([outputName, { value }]: any) => [outputName, value])),
            };
          } catch (e) {
            await exec(path.join(import.meta.dirname, './terraform'), [
              'apply',
              '--destroy',
              '--auto-approve',
              '--input=false',
            ], { cwd: dir });

            throw e;
          }
        case 'Delete':
          await exec(path.join(import.meta.dirname, './terraform'), [
            'init',
            '--input=false',
            `--backend-config=bucket=${ev.ResourceProperties.S3BackendBucket}`,
            `--backend-config=region=${ev.ResourceProperties.S3BackendBucketRegion}`,
            '--backend-config=key=tfstate',
          ], { cwd: dir });

          await exec(path.join(import.meta.dirname, './terraform'), [
            'apply',
            '--destroy',
            '--auto-approve',
            '--input=false',
          ], { cwd: dir });

          break;
      }
    } finally {
      console.log('Cleaning up...');
      fs.rmSync(dir, { recursive: true });
    }

    console.log('Successfully finished.');

    return {};
  } catch (e: any) {
    console.log(e);
    return {
      Error: e?.message ?? e?.toString?.() ?? e,
      Stack: (e as Error).stack,
      Detail: JSON.stringify(e),
      CommandOutput: e.out,
    };
  }
}

function exec(command: string, args: string[], options?: childProcess.SpawnOptionsWithoutStdio) {
  let stdout: string = '';
  let stderr: string = '';
  let out: string = '';

  console.log(`Running: '${command}' '${args.join("' '")}'`);

  return new Promise<{ stdout: string, stderr: string, out: string }>((resolve, reject) => {
    const child = childProcess.spawn(command, args, options);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      process.stdout.write(chunk);
      stdout += chunk;
      out += chunk;
    });

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => {
      process.stderr.write(chunk);
      stderr += chunk;
      out += chunk;
    });

    child.on('close', (code) => {
      if (code === 0) resolve({ stdout, stderr, out });
      else {
        const e = new class extends Error {
          constructor(msg: string, readonly out: string) {
            super(msg);
          }
        }(`Process exited with code ${code}.`, out);
        reject(e);
      }
    });
  });
}
