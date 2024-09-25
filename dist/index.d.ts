import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as cdktf from 'cdktf';
import * as constructs from 'constructs';
export declare class TerraformStackAdapter extends cdk.Resource {
    app: cdktf.App;
    deployerRole: iam.IRole;
    constructor(scope: constructs.Construct, id: string);
}
export declare function tokenStringFromAwsToTerraform(orig: string): string;
export declare function tokenStringFromTerraformToAws(orig: string): string;
