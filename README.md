# cdktf-in-aws-cdk

Run a **CDK for Terraform (CDKTF)** stack *inside* your **AWS CDK** app — keep one CLI, one synth, and freely pass values between the two worlds.

This library provides a tiny adapter that lets you mount a `cdktf.TerraformStack` beneath a normal `aws-cdk-lib.Stack`, plus helpers to shuttle tokens/strings back and forth.

---

## Why?

* You like AWS CDK’s app/project structure but want to use **providers that CDK doesn’t have** (e.g., Google, Cloudflare, Datadog) or Terraform-only resources.
* You want a **single place to orchestrate** infra (construct tree, parameters, CI) while selectively authoring parts with CDKTF.
* You need to **pass parameters across** (CDK → CDKTF, and CDKTF → CDK).

---

## Install

```bash
npm i cdktf-in-aws-cdk
# and your usual deps
npm i aws-cdk-lib constructs cdktf @cdktf/provider-aws @cdktf/provider-google
```

> Works with TypeScript/Node projects using CDK v2 and recent CDKTF versions.

---

## Quick Start

### 1) Mount a CDKTF stack in a CDK stack

```ts
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { TerraformStack as CdktfTerraformStack } from 'cdktf';
import { provider, cloudRunV2Service, dataGoogleIamRole, cloudRunV2ServiceIamBinding } from '@cdktf/provider-google';
import { TerraformStackAdapter } from 'cdktf-in-aws-cdk';

class OtpTerraformStack extends CdktfTerraformStack {
  constructor(scope: Construct, id: string) {
    super(scope, id);

    new provider.GoogleProvider(this, "google", {});

    const service = new cloudRunV2Service.CloudRunV2Service(this, "otp-service", {
      name: "opentripplanner",
      location: "us-central1",
      template: {
        containers: [{
          image: "ghcr.io/opentripplanner/opentripplanner:2.5.0",
          ports: { containerPort: 8080 },
          resources: { limits: { cpu: "1", memory: "4Gi" } },
        }],
      },
    });

    const invokerRole = new dataGoogleIamRole.DataGoogleIamRole(this, "invoker-role", {
      name: "roles/run.invoker"
    });

    new cloudRunV2ServiceIamBinding.CloudRunV2ServiceIamBinding(this, "invoker-binding", {
      name: service.name,
      location: service.location,
      project: service.project,
      role: invokerRole.name,
      members: ["allUsers"],
    });
  }
}

export class OtpCdkStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // 👇 Create an adapter and use its .app as the CDKTF scope
    const adapter = new TerraformStackAdapter(this, "OtpTerraformStack");
    new OtpTerraformStack(adapter.app, 'OTP');
  }
}

new OtpCdkStack(new cdk.App(), 'OpenTripPlanner');
```

What’s happening?

* `TerraformStackAdapter` is a CDK `Construct`.
* It exposes a CDKTF `App` at `adapter.app`.
* You instantiate your normal `cdktf.TerraformStack` under that app.
* From CDK’s perspective, the CDKTF part is “just another construct subtree.”

---

### 2) Pass values between CDK and CDKTF

* **CDK → CDKTF**: Convert CDK tokens (like `CfnParameter`) into concrete strings CDKTF can use.
* **CDKTF → CDK**: Publish CDKTF-computed strings back to CDK (e.g., show an endpoint as a `CfnOutput`).

```ts
import * as aws from '@cdktf/provider-aws';
import * as cdk from 'aws-cdk-lib';
import * as cdktf from 'cdktf';
import * as constructs from 'constructs';
import * as path from 'path';
import {
  TerraformStackAdapter,
  tokenStringFromAwsToTerraform,
  tokenStringFromTerraformToAws,
} from 'cdktf-in-aws-cdk';

class TfLambdaStack extends cdktf.TerraformStack {
  public apiEndpoint: string;

  constructor(scope: constructs.Construct, name: string, config: {
    path: string, handler: string, runtime: string, version: string,
  }) {
    super(scope, name);

    new aws.provider.AwsProvider(this, 'aws', { region: 'ap-northeast-1' });

    // package lambda code as a Terraform asset
    const asset = new cdktf.TerraformAsset(this, 'lambda-asset', {
      path: path.resolve('.', config.path),
      type: cdktf.AssetType.ARCHIVE,
    });

    const bucket = new aws.s3Bucket.S3Bucket(this, 'bucket', {
      bucketPrefix: `learn-cdktf-${name}`,
    });

    const lambdaArchive = new aws.s3Object.S3Object(this, 'lambda-archive', {
      bucket: bucket.bucket,
      key: `${config.version}/${asset.fileName}`,
      source: asset.path,
    });

    const role = new aws.iamRole.IamRole(this, 'lambda-exec', {
      name: `learn-cdktf-${name}`,
      assumeRolePolicy: JSON.stringify({
        Version: '2012-10-17',
        Statement: [{ Action: 'sts:AssumeRole', Principal: { Service: 'lambda.amazonaws.com' }, Effect: 'Allow' }],
      }),
    });

    new aws.iamRolePolicyAttachment.IamRolePolicyAttachment(this, 'lambda-managed-policy', {
      policyArn: 'arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole',
      role: role.name,
    });

    const lambdaFunc = new aws.lambdaFunction.LambdaFunction(this, 'handler', {
      functionName: `learn-cdktf-${name}`,
      s3Bucket: bucket.bucket,
      s3Key: lambdaArchive.key,
      handler: config.handler,
      runtime: config.runtime,
      role: role.arn,
    });

    const api = new aws.apigatewayv2Api.Apigatewayv2Api(this, 'api', {
      name: name,
      protocolType: 'HTTP',
      target: lambdaFunc.arn,
    });

    new aws.lambdaPermission.LambdaPermission(this, 'invoke', {
      functionName: lambdaFunc.functionName,
      action: 'lambda:InvokeFunction',
      principal: 'apigateway.amazonaws.com',
      sourceArn: `${api.executionArn}/*/*`,
    });

    this.apiEndpoint = api.apiEndpoint;
  }
}

class AwsStack extends cdk.Stack {
  constructor(scope: constructs.Construct, id: string) {
    super(scope, id);

    const versionParam = new cdk.CfnParameter(this, 'Version', {
      type: 'String',
      default: 'v1',
    });

    const tf = new TerraformStackAdapter(this, 'TfStack');

    const tfStack = new TfLambdaStack(tf.app, 'lambda-hello-world', {
      path: './lambda-hello-world/dist',
      handler: 'index.handler',
      runtime: 'nodejs20.x',
      // CDK token → plain string for CDKTF
      version: tokenStringFromAwsToTerraform(versionParam.valueAsString),
    });

    // CDKTF value → CDK output
    new cdk.CfnOutput(this, 'ApiEndpoint', {
      value: tokenStringFromTerraformToAws(tfStack.apiEndpoint),
    });
  }
}

new AwsStack(new cdk.App(), 'aws-stack');
```

---

## API

### `class TerraformStackAdapter extends Construct`

Mounts a CDKTF app inside your CDK stack.

* **Constructor**: `new TerraformStackAdapter(scope: Construct, id: string)`
* **Properties**

  * `app: cdktf.App` — use this as the scope for your `cdktf.TerraformStack` instances.

> You can create multiple adapters if you want to logically separate CDKTF apps.

### `tokenStringFromAwsToTerraform(value: string): string`

Converts a CDK token/string (which may resolve lazily) into a **concrete string** that CDKTF can safely consume at synth/apply time.

Typical use: CDK `CfnParameter` → CDKTF resource argument.

### `tokenStringFromTerraformToAws(value: string): string`

Converts a **CDKTF-produced string** back into something CDK can wire into outputs, other constructs, etc.

Typical use: surface a CDKTF-generated endpoint/ARN as a `CfnOutput`.

> These helpers are intentionally narrow: they focus on string values. If you need richer data, emit/parse JSON strings.

---

## Patterns & Tips

* **Providers & Backends**
  Configure CDKTF providers and state backends as you normally would *inside* your `TerraformStack`. If you don’t set a backend, CDKTF uses its defaults (often local).

* **Multiple stacks**
  It’s fine to create several `TerraformStack`s under the same `TerraformStackAdapter.app`, or use several adapters.

* **Parameters / Context**
  Use CDK `CfnParameter`, SSM Parameters, or context to feed values into CDKTF, then convert with `tokenStringFromAwsToTerraform`.

* **Outputs**
  For simple values, just keep them as `public` properties on your CDKTF stack and convert them back with `tokenStringFromTerraformToAws` to export via `CfnOutput`.

* **Ordering**
  Because everything lives in the **same construct tree**, CDK/CMake-style synthesis ordering generally “just works.” If you have cross-dependencies (e.g., CDKTF needs an ARN created by CDK), pass it in through the constructor using the token converters.

---

## Troubleshooting

* **“My CDKTF value is empty in CDK output.”**
  Ensure you’re using `tokenStringFromTerraformToAws(...)` when wiring CDKTF properties back into CDK.

* **“Provider can’t find credentials.”**
  CDKTF still uses provider-native auth. Make sure your environment variables/credentials are available during `cdk synth/deploy`.

* **“I need non-string data.”**
  Serialize as JSON on the CDKTF side and parse on the CDK side (or vice versa). The included helpers are string-focused by design.

---

## License

MIT © Contributors to `cdktf-in-aws-cdk`

