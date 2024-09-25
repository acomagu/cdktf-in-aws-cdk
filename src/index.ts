import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3Assets from 'aws-cdk-lib/aws-s3-assets';
import * as customresources from 'aws-cdk-lib/custom-resources';
import * as cdktf from 'cdktf';
import * as constructs from 'constructs';
import * as fs from 'node:fs';
import * as path from 'node:path';

export class TerraformStackAdapter extends cdk.Resource {
  app: cdktf.App;
  deployerRole: iam.IRole;
  constructor(scope: constructs.Construct, id: string) {
    super(scope, id);

    this.app = new cdktf.App();

    const handler = singletonResource(this, `${this.app.node.id}/EventHandler`, () => {
      const fn = new lambda.DockerImageFunction(this, 'EventHandler', {
        ephemeralStorageSize: cdk.Size.gibibytes(2),
        code: lambda.DockerImageCode.fromImageAsset(path.join(__dirname, '../handler'), {
          outputs: ['type=docker'],
        }),
        timeout: cdk.Duration.minutes(15),
        architecture: lambda.Architecture.ARM_64,
        memorySize: 1024,
      });

      return fn;
    });
    this.deployerRole = handler.role!;

    const tfStateBucket = new s3.Bucket(this, 'TFStateBucket');

    cdk.attachCustomSynthesis(this, {
      onSynthesize: () => {
        let terraformDeployer: cdk.CustomResource;
        let tfStack: cdktf.TerraformStack;
        { // TF側
          const stacks = this.app.node.children.filter(cdktf.TerraformStack.isStack);
          if (!stacks.length) throw new Error('No Stack constructed. app should have a TerraformStack associated with it.');
          if (stacks.length > 1) throw new Error('Multiple stacks to one app is not supported currently. Please create multiple TerraformStackConstruct.');
          tfStack = stacks[0]!;

          // ここでAWS側のTfCdkReferenceを走査してTerraform側にOutputを作る
          const awsStack = cdk.Stack.of(this);
          for (const source of awsStack.node.findAll()) {
            if (!cdk.CfnElement.isCfnElement(source)) continue;
            const tokens = awsFindTokens(source, JSON.stringify(source._toCloudFormation()));
            for (const token of tokens) {
              if (!(token instanceof TfCdkReference)) continue;

              new cdktf.TerraformOutput(tfStack, token.tfOutputName, {
                value: token.resolvable,
              });
            }
          }

          // S3 Backendの設定はinit時にフラグで指定する
          tfStack.addOverride('terraform.backend', {
            s3: {},
          });

          cdktf.Aspects.of(tfStack).add({
            visit: construct => {
              if (construct instanceof cdktf.TerraformBackend) {
                console.warn(`Custom Backend cannot be used currently. Only builtin S3 backend is supported. ${construct.constructor.name}`);
                tfStack.node.tryRemoveChild(construct.node.id);
              }
            },
          });

          this.app.synth();
          console.log(this.app.outdir);

          const terraformJson = fs.readFileSync(`${this.app.outdir}/stacks/${tfStack.node.id}/cdk.tf.json`).toString('utf-8');
          const terraform = JSON.parse(terraformJson);

          // ここでAwsCdkReferenceを走査して集めてInputしておく
          const vars: Record<string, string> = {};

          for (const source of tfStack.node.findAll()) {
            if (!cdktf.TerraformElement.isTerraformElement(source)) continue;
            const tokens = tfFindTokens(source, source.toTerraform());
            for (const token of tokens) {
              if (!(token instanceof AwsCdkReference)) continue;

              vars[token.tfVariableName] = cdk.Token.asString(token.ref);
            }
          }

          const tfStackAssets = new s3Assets.Asset(this, 'TFCDKAssemblyAsset', {
            path: `${this.app.outdir}/stacks/${tfStack.node.id}/assets`,
          });
          tfStackAssets.grantRead(handler);

          const provider = new customresources.Provider(this, 'provider', {
            onEventHandler: handler,
          });

          terraformDeployer = new cdk.CustomResource(this, 'TerraformDeployer', {
            serviceToken: provider.serviceToken,
            properties: {
              TFStackAssetsBucketName: tfStackAssets.s3BucketName,
              TFStackAssetsObjectKey: tfStackAssets.s3ObjectKey,
              // Asset内ではなくここに置いたのはDiffのため
              Terraform: terraform,
              Variables: vars,
              S3BackendBucket: tfStateBucket.bucketName,
              S3BackendBucketRegion: tfStateBucket.stack.region,
            },
          });
        }

        { // AWS側
          const awsStack = cdk.Stack.of(this);

          for (const source of awsStack.node.findAll()) {
            if (!cdk.CfnElement.isCfnElement(source)) continue;
            const tokens = awsFindTokens(source, JSON.stringify(source._toCloudFormation()));
            for (const token of tokens) {
              if (!(token instanceof TfCdkReference)) continue;

              // OutputはDeployerのgetAttで取得できる
              token.value = terraformDeployer.getAtt(token.tfOutputName);
            }
          }
        }
      },
    });
  }
}

/**
 * Find all Tokens that are used in the given structure
 */
function awsFindTokens(scope: constructs.IConstruct, value: unknown): cdk.IResolvable[] {
  const resolver = new AwsRememberingTokenResolver(new cdk.StringConcat());

  cdk.Tokenization.resolve(value, { scope, resolver, preparing: true });

  return resolver.tokens;
}

/**
 * Find all Tokens that are used in the given structure
 */
function tfFindTokens(scope: constructs.IConstruct, value: unknown): cdktf.IResolvable[] {
  const resolver = new TfRememberingTokenResolver(new cdktf.StringConcat());

  cdktf.Tokenization.resolve(value, { scope, resolver, preparing: true });

  return resolver.tokens;
}

/**
 * Remember all Tokens encountered while resolving
 */
class AwsRememberingTokenResolver extends cdk.DefaultTokenResolver {
  private readonly tokensSeen = new Set<cdk.IResolvable>();

  public resolveToken(
    t: cdk.IResolvable,
    context: cdk.IResolveContext,
    postProcessor: cdk.IPostProcessor
  ) {
    this.tokensSeen.add(t);
    return super.resolveToken(t, context, postProcessor);
  }

  public resolveString(s: cdk.TokenizedStringFragments, context: cdk.IResolveContext) {
    return super.resolveString(s, context);
  }

  public get tokens(): cdk.IResolvable[] {
    return Array.from(this.tokensSeen);
  }
}

/**
 * Remember all Tokens encountered while resolving
 */
class TfRememberingTokenResolver extends cdktf.DefaultTokenResolver {
  private readonly tokensSeen = new Set<cdktf.IResolvable>();

  public resolveToken(
    t: cdktf.IResolvable,
    context: cdktf.IResolveContext,
    postProcessor: cdktf.IPostProcessor
  ) {
    this.tokensSeen.add(t);
    return super.resolveToken(t, context, postProcessor);
  }

  public resolveString(s: cdktf.TokenizedStringFragments, context: cdktf.IResolveContext) {
    return super.resolveString(s, context);
  }

  public get tokens(): cdktf.IResolvable[] {
    return Array.from(this.tokensSeen);
  }
}

class AwsCdkReference implements cdktf.IResolvable {
  creationStack = [];
  cache: unknown;
  tfVariableName: string;
  constructor(readonly ref: cdk.Reference) {
    const tokenNum = /\[TOKEN\.(\d+)\]/.exec(ref.toString())?.[1];
    if (tokenNum == undefined) console.warn(`Failed to detect token number from token ${ref.toString()}`);

    this.tfVariableName = `cdk-${this.ref.displayName}-${tokenNum}`;
  }
  resolve(context: cdktf.IResolveContext) {
    if (this.cache !== undefined) return this.cache; // context.scopeが違ったらどうする？

    let inputType: string | undefined = undefined;
    switch (this.ref.typeHint) {
      case cdk.ResolutionTypeHint.NUMBER:
        inputType = 'number';
        break;
      case cdk.ResolutionTypeHint.STRING:
        inputType = 'string';
        break;
      case cdk.ResolutionTypeHint.STRING_LIST:
        inputType = 'list(string)';
        break;
    }

    const input = new cdktf.TerraformVariable(cdktf.TerraformStack.of(context.scope), this.tfVariableName, {
      type: inputType,
      nullable: false,
    });

    this.cache = input.value;

    return input.value;
  }
  toString(): string {
    return this.ref.toString();
  }
}

class TfCdkReference implements cdk.IResolvable {
  creationStack = [];
  tfOutputName: string;
  value?: unknown;
  constructor(readonly resolvable: cdktf.IResolvable) {
    const tokenNum = /\[TOKEN\.(\d+)\]/.exec(resolvable.toString())?.[1];
    if (tokenNum == undefined) console.warn(`Failed to detect token number from token ${resolvable.toString()}`);

    this.tfOutputName = `cdk-out-${tokenNum}`;
  }
  resolve() {
    // const output = new cdktf.TerraformOutput(cdktf.TerraformStack.of(context.scope), this.cdkVariableName, {
    //   type: inputType,
    //   nullable: false,
    // });
    if (!this.value) {
      return '<undetermined>';
    }
    return this.value;
  }
  toString(): string {
    return this.resolvable.toString();
  }
}

export function tokenStringFromAwsToTerraform(orig: string): string {
  if (!cdk.Token.isUnresolved(orig)) return orig;

  const fragments = cdk.Tokenization.reverseString(orig);
  const tfFragments = fragments.mapTokens({
    mapToken(t) {
      if (cdk.Reference.isReference(t)) {
        return cdktf.Token.asString(new AwsCdkReference(t));
      }

      return t;
    },
  });

  return tfFragments.join(new cdk.StringConcat());
}

export function tokenStringFromTerraformToAws(orig: string): string {
  if (!cdktf.Token.isUnresolved(orig)) return orig;

  const tfFragments = cdktf.Tokenization.reverseString(orig);
  const fragments = tfFragments.mapTokens({
    resolve(x) {
      if (cdktf.Tokenization.isResolvable(x)) {
        return cdk.Token.asString(new TfCdkReference(x));
      }

      return x;
    },
    scope: undefined as any, // Actually not used.
    preparing: true,
    registerPostProcessor: undefined as any, // Actually not used.
  });

  return fragments.join(new cdktf.StringConcat());
}

function singletonResource<T extends constructs.IConstruct>(scope: constructs.IConstruct, globalId: string, factory: () => T): T {
  const stack = cdk.Stack.of(scope);
  const existing = stack.node.tryFindChild(globalId);
  if (existing) return existing as T;
  return factory();
}
