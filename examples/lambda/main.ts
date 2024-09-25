import * as aws from '@cdktf/provider-aws';
import * as random from '@cdktf/provider-random';
import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as cdktf from 'cdktf';
import * as constructs from 'constructs';
import * as util from 'node:util';
import * as path from 'path';
import { TerraformStackResource, tokenStringFromAwsToTerraform, tokenStringFromTerraformToAws } from 'cdktf-in-aws-cdk';

util.inspect.defaultOptions.depth = 7;

class TfLambdaStack extends cdktf.TerraformStack {
  apiEndpoint: string;
  constructor(scope: constructs.Construct, name: string, config: {
    path: string,
    handler: string,
    runtime: string,
    version: string,
  }) {
    super(scope, name);

    new aws.provider.AwsProvider(this, 'aws', {
      region: 'ap-northeast-1',
    });

    // Create Lambda executable
    const asset = new cdktf.TerraformAsset(this, 'lambda-asset', {
      path: path.resolve('.', config.path),
      type: cdktf.AssetType.ARCHIVE, // if left empty it infers directory and file
    });

    // Create unique S3 bucket that hosts Lambda executable
    const bucket = new aws.s3Bucket.S3Bucket(this, 'bucket', {
      bucketPrefix: `learn-cdktf-${name}`,
    });

    // Upload Lambda zip file to newly created S3 bucket
    const lambdaArchive = new aws.s3Object.S3Object(this, 'lambda-archive', {
      bucket: bucket.bucket,
      key: `${config.version}/${asset.fileName}`,
      source: asset.path, // returns a posix path
    });

    // Create Lambda role
    const role = new aws.iamRole.IamRole(this, 'lambda-exec', {
      name: `learn-cdktf-${name}-${pet.id}`,
      assumeRolePolicy: JSON.stringify({
        'Version': '2012-10-17',
        'Statement': [
          {
            'Action': 'sts:AssumeRole',
            'Principal': {
              'Service': 'lambda.amazonaws.com',
            },
            'Effect': 'Allow',
            'Sid': '',
          },
        ],
      }),
    });

    // Add execution role for lambda to write to CloudWatch logs
    new aws.iamRolePolicyAttachment.IamRolePolicyAttachment(this, 'lambda-managed-policy', {
      policyArn: 'arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole',
      role: role.name
    });

    // Create Lambda function
    const lambdaFunc = new aws.lambdaFunction.LambdaFunction(this, 'learn-cdktf-lambda', {
      functionName: `learn-cdktf-${name}-${pet.id}`,
      s3Bucket: bucket.bucket,
      s3Key: lambdaArchive.key,
      handler: config.handler,
      runtime: config.runtime,
      role: role.arn
    });

    // Create and configure API gateway
    const api = new aws.apigatewayv2Api.Apigatewayv2Api(this, 'api-gw', {
      name: name,
      protocolType: 'HTTP',
      target: lambdaFunc.arn
    });

    new aws.lambdaPermission.LambdaPermission(this, 'apigw-lambda', {
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

    const testParam = new cdk.CfnParameter(this, 'TestParam', {
      type: 'String',
      default: 'testvalue'
    });

    const tfAdapter = new TerraformStackAdapter(this, 'TfStack');

    const tfStack = new TfLambdaStack(tfAdapter.app, 'lambda-hello-world', {
      path: './lambda-hello-world/dist',
      handler: 'index.handler',
      runtime: 'nodejs20.x',
      version: tokenStringFromAwsToTerraform(testParam.valueAsString),
    });

    new cdk.CfnOutput(this, 'TestOutput', {
      value: tokenStringFromTerraformToAws(tfStack.apiEndpoint),
    });
  }
}

const app = new cdk.App();

new AwsStack(app, 'aws-stack');

app.synth();
