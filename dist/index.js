import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3Assets from 'aws-cdk-lib/aws-s3-assets';
import * as customresources from 'aws-cdk-lib/custom-resources';
import * as cdktf from 'cdktf';
import * as fs from 'node:fs';
import * as path from 'node:path';
export class TerraformStackAdapter extends cdk.Resource {
    constructor(scope, id) {
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
        this.deployerRole = handler.role;
        const tfStateBucket = new s3.Bucket(this, 'TFStateBucket');
        cdk.attachCustomSynthesis(this, {
            onSynthesize: () => {
                let terraformDeployer;
                let tfStack;
                { // TF側
                    const stacks = this.app.node.children.filter(cdktf.TerraformStack.isStack);
                    if (!stacks.length)
                        throw new Error('No Stack constructed. app should have a TerraformStack associated with it.');
                    if (stacks.length > 1)
                        throw new Error('Multiple stacks to one app is not supported currently. Please create multiple TerraformStackConstruct.');
                    tfStack = stacks[0];
                    // ここでAWS側のTfCdkReferenceを走査してTerraform側にOutputを作る
                    const awsStack = cdk.Stack.of(this);
                    for (const source of awsStack.node.findAll()) {
                        if (!cdk.CfnElement.isCfnElement(source))
                            continue;
                        const tokens = awsFindTokens(source, JSON.stringify(source._toCloudFormation()));
                        for (const token of tokens) {
                            if (!(token instanceof TfCdkReference))
                                continue;
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
                    const vars = {};
                    for (const source of tfStack.node.findAll()) {
                        if (!cdktf.TerraformElement.isTerraformElement(source))
                            continue;
                        const tokens = tfFindTokens(source, source.toTerraform());
                        for (const token of tokens) {
                            if (!(token instanceof AwsCdkReference))
                                continue;
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
                        if (!cdk.CfnElement.isCfnElement(source))
                            continue;
                        const tokens = awsFindTokens(source, JSON.stringify(source._toCloudFormation()));
                        for (const token of tokens) {
                            if (!(token instanceof TfCdkReference))
                                continue;
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
function awsFindTokens(scope, value) {
    const resolver = new AwsRememberingTokenResolver(new cdk.StringConcat());
    cdk.Tokenization.resolve(value, { scope, resolver, preparing: true });
    return resolver.tokens;
}
/**
 * Find all Tokens that are used in the given structure
 */
function tfFindTokens(scope, value) {
    const resolver = new TfRememberingTokenResolver(new cdktf.StringConcat());
    cdktf.Tokenization.resolve(value, { scope, resolver, preparing: true });
    return resolver.tokens;
}
/**
 * Remember all Tokens encountered while resolving
 */
class AwsRememberingTokenResolver extends cdk.DefaultTokenResolver {
    constructor() {
        super(...arguments);
        this.tokensSeen = new Set();
    }
    resolveToken(t, context, postProcessor) {
        this.tokensSeen.add(t);
        return super.resolveToken(t, context, postProcessor);
    }
    resolveString(s, context) {
        return super.resolveString(s, context);
    }
    get tokens() {
        return Array.from(this.tokensSeen);
    }
}
/**
 * Remember all Tokens encountered while resolving
 */
class TfRememberingTokenResolver extends cdktf.DefaultTokenResolver {
    constructor() {
        super(...arguments);
        this.tokensSeen = new Set();
    }
    resolveToken(t, context, postProcessor) {
        this.tokensSeen.add(t);
        return super.resolveToken(t, context, postProcessor);
    }
    resolveString(s, context) {
        return super.resolveString(s, context);
    }
    get tokens() {
        return Array.from(this.tokensSeen);
    }
}
class AwsCdkReference {
    constructor(ref) {
        this.ref = ref;
        this.creationStack = [];
        const tokenNum = /\[TOKEN\.(\d+)\]/.exec(ref.toString())?.[1];
        if (tokenNum == undefined)
            console.warn(`Failed to detect token number from token ${ref.toString()}`);
        this.tfVariableName = `cdk-${this.ref.displayName}-${tokenNum}`;
    }
    resolve(context) {
        if (this.cache !== undefined)
            return this.cache; // context.scopeが違ったらどうする？
        let inputType = undefined;
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
    toString() {
        return this.ref.toString();
    }
}
class TfCdkReference {
    constructor(resolvable) {
        this.resolvable = resolvable;
        this.creationStack = [];
        const tokenNum = /\[TOKEN\.(\d+)\]/.exec(resolvable.toString())?.[1];
        if (tokenNum == undefined)
            console.warn(`Failed to detect token number from token ${resolvable.toString()}`);
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
    toString() {
        return this.resolvable.toString();
    }
}
export function tokenStringFromAwsToTerraform(orig) {
    if (!cdk.Token.isUnresolved(orig))
        return orig;
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
export function tokenStringFromTerraformToAws(orig) {
    if (!cdktf.Token.isUnresolved(orig))
        return orig;
    const tfFragments = cdktf.Tokenization.reverseString(orig);
    const fragments = tfFragments.mapTokens({
        resolve(x) {
            if (cdktf.Tokenization.isResolvable(x)) {
                return cdk.Token.asString(new TfCdkReference(x));
            }
            return x;
        },
        scope: undefined, // Actually not used.
        preparing: true,
        registerPostProcessor: undefined, // Actually not used.
    });
    return fragments.join(new cdktf.StringConcat());
}
function singletonResource(scope, globalId, factory) {
    const stack = cdk.Stack.of(scope);
    const existing = stack.node.tryFindChild(globalId);
    if (existing)
        return existing;
    return factory();
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiaW5kZXguanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi9zcmMvaW5kZXgudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUEsT0FBTyxLQUFLLEdBQUcsTUFBTSxhQUFhLENBQUM7QUFFbkMsT0FBTyxLQUFLLE1BQU0sTUFBTSx3QkFBd0IsQ0FBQztBQUNqRCxPQUFPLEtBQUssRUFBRSxNQUFNLG9CQUFvQixDQUFDO0FBQ3pDLE9BQU8sS0FBSyxRQUFRLE1BQU0sMkJBQTJCLENBQUM7QUFDdEQsT0FBTyxLQUFLLGVBQWUsTUFBTSw4QkFBOEIsQ0FBQztBQUNoRSxPQUFPLEtBQUssS0FBSyxNQUFNLE9BQU8sQ0FBQztBQUUvQixPQUFPLEtBQUssRUFBRSxNQUFNLFNBQVMsQ0FBQztBQUM5QixPQUFPLEtBQUssSUFBSSxNQUFNLFdBQVcsQ0FBQztBQUVsQyxNQUFNLE9BQU8scUJBQXNCLFNBQVEsR0FBRyxDQUFDLFFBQVE7SUFHckQsWUFBWSxLQUEyQixFQUFFLEVBQVU7UUFDakQsS0FBSyxDQUFDLEtBQUssRUFBRSxFQUFFLENBQUMsQ0FBQztRQUVqQixJQUFJLENBQUMsR0FBRyxHQUFHLElBQUksS0FBSyxDQUFDLEdBQUcsRUFBRSxDQUFDO1FBRTNCLE1BQU0sT0FBTyxHQUFHLGlCQUFpQixDQUFDLElBQUksRUFBRSxHQUFHLElBQUksQ0FBQyxHQUFHLENBQUMsSUFBSSxDQUFDLEVBQUUsZUFBZSxFQUFFLEdBQUcsRUFBRTtZQUMvRSxNQUFNLEVBQUUsR0FBRyxJQUFJLE1BQU0sQ0FBQyxtQkFBbUIsQ0FBQyxJQUFJLEVBQUUsY0FBYyxFQUFFO2dCQUM5RCxvQkFBb0IsRUFBRSxHQUFHLENBQUMsSUFBSSxDQUFDLFNBQVMsQ0FBQyxDQUFDLENBQUM7Z0JBQzNDLElBQUksRUFBRSxNQUFNLENBQUMsZUFBZSxDQUFDLGNBQWMsQ0FBQyxJQUFJLENBQUMsSUFBSSxDQUFDLFNBQVMsRUFBRSxZQUFZLENBQUMsRUFBRTtvQkFDOUUsT0FBTyxFQUFF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QUFNLFFBQVEsR0FBRyxLQUFLLENBQUMsSUFBSSxDQUFDLFlBQVksQ0FBQyxRQUFRLENBQUMsQ0FBQztJQUNuRCxJQUFJLFFBQVE7UUFBRSxPQUFPLFFBQWEsQ0FBQztJQUNuQyxPQUFPLE9BQU8sRUFBRSxDQUFDO0FBQ25CLENBQUMiLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgKiBhcyBjZGsgZnJvbSAnYXdzLWNkay1saWInO1xuaW1wb3J0ICogYXMgaWFtIGZyb20gJ2F3cy1jZGstbGliL2F3cy1pYW0nO1xuaW1wb3J0ICogYXMgbGFtYmRhIGZyb20gJ2F3cy1jZGstbGliL2F3cy1sYW1iZGEnO1xuaW1wb3J0ICogYXMgczMgZnJvbSAnYXdzLWNkay1saWIvYXdzLXMzJztcbmltcG9ydCAqIGFzIHMzQXNzZXRzIGZyb20gJ2F3cy1jZGstbGliL2F3cy1zMy1hc3NldHMnO1xuaW1wb3J0ICogYXMgY3VzdG9tcmVzb3VyY2VzIGZyb20gJ2F3cy1jZGstbGliL2N1c3RvbS1yZXNvdXJjZXMnO1xuaW1wb3J0ICogYXMgY2RrdGYgZnJvbSAnY2RrdGYnO1xuaW1wb3J0ICogYXMgY29uc3RydWN0cyBmcm9tICdjb25zdHJ1Y3RzJztcbmltcG9ydCAqIGFzIGZzIGZyb20gJ25vZGU6ZnMnO1xuaW1wb3J0ICogYXMgcGF0aCBmcm9tICdub2RlOnBhdGgnO1xuXG5leHBvcnQgY2xhc3MgVGVycmFmb3JtU3RhY2tBZGFwdGVyIGV4dGVuZHMgY2RrLlJlc291cmNlIHtcbiAgYXBwOiBjZGt0Zi5BcHA7XG4gIGRlcGxveWVyUm9sZTogaWFtLklSb2xlO1xuICBjb25zdHJ1Y3RvcihzY29wZTogY29uc3RydWN0cy5Db25zdHJ1Y3QsIGlkOiBzdHJpbmcpIHtcbiAgICBzdXBlcihzY29wZSwgaWQpO1xuXG4gICAgdGhpcy5hcHAgPSBuZXcgY2RrdGYuQXBwKCk7XG5cbiAgICBjb25zdCBoYW5kbGVyID0gc2luZ2xldG9uUmVzb3VyY2UodGhpcywgYCR7dGhpcy5hcHAubm9kZS5pZH0vRXZlbnRIYW5kbGVyYCwgKCkgPT4ge1xuICAgICAgY29uc3QgZm4gPSBuZXcgbGFtYmRhLkRvY2tlckltYWdlRnVuY3Rpb24odGhpcywgJ0V2ZW50SGFuZGxlcicsIHtcbiAgICAgICAgZXBoZW1lcmFsU3RvcmFnZVNpemU6IGNkay5TaXplLmdpYmlieXRlcygyKSxcbiAgICAgICAgY29kZTogbGFtYmRhLkRvY2tlckltYWdlQ29kZS5mcm9tSW1hZ2VBc3NldChwYXRoLmpvaW4oX19kaXJuYW1lLCAnLi4vaGFuZGxlcicpLCB7XG4gICAgICAgICAgb3V0cHV0czogWyd0eXBlPWRvY2tlciddLFxuICAgICAgICB9KSxcbiAgICAgICAgdGltZW91dDogY2RrLkR1cmF0aW9uLm1pbnV0ZXMoMTUpLFxuICAgICAgICBhcmNoaXRlY3R1cmU6IGxhbWJkYS5BcmNoaXRlY3R1cmUuQVJNXzY0LFxuICAgICAgICBtZW1vcnlTaXplOiAxMDI0LFxuICAgICAgfSk7XG5cbiAgICAgIHJldHVybiBmbjtcbiAgICB9KTtcbiAgICB0aGlzLmRlcGxveWVyUm9sZSA9IGhhbmRsZXIucm9sZSE7XG5cbiAgICBjb25zdCB0ZlN0YXRlQnVja2V0ID0gbmV3IHMzLkJ1Y2tldCh0aGlzLCAnVEZTdGF0ZUJ1Y2tldCcpO1xuXG4gICAgY2RrLmF0dGFjaEN1c3RvbVN5bnRoZXNpcyh0aGlzLCB7XG4gICAgICBvblN5bnRoZXNpemU6ICgpID0+IHtcbiAgICAgICAgbGV0IHRlcnJhZm9ybURlcGxveWVyOiBjZGsuQ3VzdG9tUmVzb3VyY2U7XG4gICAgICAgIGxldCB0ZlN0YWNrOiBjZGt0Zi5UZXJyYWZvcm1TdGFjaztcbiAgICAgICAgeyAvLyBURuWBtFxuICAgICAgICAgIGNvbnN0IHN0YWNrcyA9IHRoaXMuYXBwLm5vZGUuY2hpbGRyZW4uZmlsdGVyKGNka3RmLlRlcnJhZm9ybVN0YWNrLmlzU3RhY2spO1xuICAgICAgICAgIGlmICghc3RhY2tzLmxlbmd0aCkgdGhyb3cgbmV3IEVycm9yKCdObyBTdGFjayBjb25zdHJ1Y3RlZC4gYXBwIHNob3VsZCBoYXZlIGEgVGVycmFmb3JtU3RhY2sgYXNzb2NpYXRlZCB3aXRoIGl0LicpO1xuICAgICAgICAgIGlmIChzdGFja3MubGVuZ3RoID4gMSkgdGhyb3cgbmV3IEVycm9yKCdNdWx0aXBsZSBzdGFja3MgdG8gb25lIGFwcCBpcyBub3Qgc3VwcG9ydGVkIGN1cnJlbnRseS4gUGxlYXNlIGNyZWF0ZSBtdWx0aXBsZSBUZXJyYWZvcm1TdGFja0NvbnN0cnVjdC4nKTtcbiAgICAgICAgICB0ZlN0YWNrID0gc3RhY2tzWzBdITtcblxuICAgICAgICAgIC8vIOOBk+OBk+OBp0FXU+WBtOOBrlRmQ2RrUmVmZXJlbmNl44KS6LWw5p+744GX44GmVGVycmFmb3Jt5YG044GrT3V0cHV044KS5L2c44KLXG4gICAgICAgICAgY29uc3QgYXdzU3RhY2sgPSBjZGsuU3RhY2sub2YodGhpcyk7XG4gICAgICAgICAgZm9yIChjb25zdCBzb3VyY2Ugb2YgYXdzU3RhY2subm9kZS5maW5kQWxsKCkpIHtcbiAgICAgICAgICAgIGlmICghY2RrLkNmbkVsZW1lbnQuaXNDZm5FbGVtZW50KHNvdXJjZSkpIGNvbnRpbnVlO1xuICAgICAgICAgICAgY29uc3QgdG9rZW5zID0gYXdzRmluZFRva2Vucyhzb3VyY2UsIEpTT04uc3RyaW5naWZ5KHNvdXJjZS5fdG9DbG91ZEZvcm1hdGlvbigpKSk7XG4gICAgICAgICAgICBmb3IgKGNvbnN0IHRva2VuIG9mIHRva2Vucykge1xuICAgICAgICAgICAgICBpZiAoISh0b2tlbiBpbnN0YW5jZW9mIFRmQ2RrUmVmZXJlbmNlKSkgY29udGludWU7XG5cbiAgICAgICAgICAgICAgbmV3IGNka3RmLlRlcnJhZm9ybU91dHB1dCh0ZlN0YWNrLCB0b2tlbi50Zk91dHB1dE5hbWUsIHtcbiAgICAgICAgICAgICAgICB2YWx1ZTogdG9rZW4ucmVzb2x2YWJsZSxcbiAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgfVxuXG4gICAgICAgICAgLy8gUzMgQmFja2VuZOOBruioreWumuOBr2luaXTmmYLjgavjg5Xjg6njgrDjgafmjIflrprjgZnjgotcbiAgICAgICAgICB0ZlN0YWNrLmFkZE92ZXJyaWRlKCd0ZXJyYWZvcm0uYmFja2VuZCcsIHtcbiAgICAgICAgICAgIHMzOiB7fSxcbiAgICAgICAgICB9KTtcblxuICAgICAgICAgIGNka3RmLkFzcGVjdHMub2YodGZTdGFjaykuYWRkKHtcbiAgICAgICAgICAgIHZpc2l0OiBjb25zdHJ1Y3QgPT4ge1xuICAgICAgICAgICAgICBpZiAoY29uc3RydWN0IGluc3RhbmNlb2YgY2RrdGYuVGVycmFmb3JtQmFja2VuZCkge1xuICAgICAgICAgICAgICAgIGNvbnNvbGUud2FybihgQ3VzdG9tIEJhY2tlbmQgY2Fubm90IGJlIHVzZWQgY3VycmVudGx5LiBPbmx5IGJ1aWx0aW4gUzMgYmFja2VuZCBpcyBzdXBwb3J0ZWQuICR7Y29uc3RydWN0LmNvbnN0cnVjdG9yLm5hbWV9YCk7XG4gICAgICAgICAgICAgICAgdGZTdGFjay5ub2RlLnRyeVJlbW92ZUNoaWxkKGNvbnN0cnVjdC5ub2RlLmlkKTtcbiAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfSxcbiAgICAgICAgICB9KTtcblxuICAgICAgICAgIHRoaXMuYXBwLnN5bnRoKCk7XG4gICAgICAgICAgY29uc29sZS5sb2codGhpcy5hcHAub3V0ZGlyKTtcblxuICAgICAgICAgIGNvbnN0IHRlcnJhZm9ybUpzb24gPSBmcy5yZWFkRmlsZVN5bmMoYCR7dGhpcy5hcHAub3V0ZGlyfS9zdGFja3MvJHt0ZlN0YWNrLm5vZGUuaWR9L2Nkay50Zi5qc29uYCkudG9TdHJpbmcoJ3V0Zi04Jyk7XG4gICAgICAgICAgY29uc3QgdGVycmFmb3JtID0gSlNPTi5wYXJzZSh0ZXJyYWZvcm1Kc29uKTtcblxuICAgICAgICAgIC8vIOOBk+OBk+OBp0F3c0Nka1JlZmVyZW5jZeOCkui1sOafu+OBl+OBpumbhuOCgeOBpklucHV044GX44Gm44GK44GPXG4gICAgICAgICAgY29uc3QgdmFyczogUmVjb3JkPHN0cmluZywgc3RyaW5nPiA9IHt9O1xuXG4gICAgICAgICAgZm9yIChjb25zdCBzb3VyY2Ugb2YgdGZTdGFjay5ub2RlLmZpbmRBbGwoKSkge1xuICAgICAgICAgICAgaWYgKCFjZGt0Zi5UZXJyYWZvcm1FbGVtZW50LmlzVGVycmFmb3JtRWxlbWVudChzb3VyY2UpKSBjb250aW51ZTtcbiAgICAgICAgICAgIGNvbnN0IHRva2VucyA9IHRmRmluZFRva2Vucyhzb3VyY2UsIHNvdXJjZS50b1RlcnJhZm9ybSgpKTtcbiAgICAgICAgICAgIGZvciAoY29uc3QgdG9rZW4gb2YgdG9rZW5zKSB7XG4gICAgICAgICAgICAgIGlmICghKHRva2VuIGluc3RhbmNlb2YgQXdzQ2RrUmVmZXJlbmNlKSkgY29udGludWU7XG5cbiAgICAgICAgICAgICAgdmFyc1t0b2tlbi50ZlZhcmlhYmxlTmFtZV0gPSBjZGsuVG9rZW4uYXNTdHJpbmcodG9rZW4ucmVmKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICB9XG5cbiAgICAgICAgICBjb25zdCB0ZlN0YWNrQXNzZXRzID0gbmV3IHMzQXNzZXRzLkFzc2V0KHRoaXMsICdURkNES0Fzc2VtYmx5QXNzZXQnLCB7XG4gICAgICAgICAgICBwYXRoOiBgJHt0aGlzLmFwcC5vdXRkaXJ9L3N0YWNrcy8ke3RmU3RhY2subm9kZS5pZH0vYXNzZXRzYCxcbiAgICAgICAgICB9KTtcbiAgICAgICAgICB0ZlN0YWNrQXNzZXRzLmdyYW50UmVhZChoYW5kbGVyKTtcblxuICAgICAgICAgIGNvbnN0IHByb3ZpZGVyID0gbmV3IGN1c3RvbXJlc291cmNlcy5Qcm92aWRlcih0aGlzLCAncHJvdmlkZXInLCB7XG4gICAgICAgICAgICBvbkV2ZW50SGFuZGxlcjogaGFuZGxlcixcbiAgICAgICAgICB9KTtcblxuICAgICAgICAgIHRlcnJhZm9ybURlcGxveWVyID0gbmV3IGNkay5DdXN0b21SZXNvdXJjZSh0aGlzLCAnVGVycmFmb3JtRGVwbG95ZXInLCB7XG4gICAgICAgICAgICBzZXJ2aWNlVG9rZW46IHByb3ZpZGVyLnNlcnZpY2VUb2tlbixcbiAgICAgICAgICAgIHByb3BlcnRpZXM6IHtcbiAgICAgICAgICAgICAgVEZTdGFja0Fzc2V0c0J1Y2tldE5hbWU6IHRmU3RhY2tBc3NldHMuczNCdWNrZXROYW1lLFxuICAgICAgICAgICAgICBURlN0YWNrQXNzZXRzT2JqZWN0S2V5OiB0ZlN0YWNrQXNzZXRzLnMzT2JqZWN0S2V5LFxuICAgICAgICAgICAgICAvLyBBc3NldOWGheOBp+OBr+OBquOBj+OBk+OBk+OBq+e9ruOBhOOBn+OBruOBr0RpZmbjga7jgZ/jgoFcbiAgICAgICAgICAgICAgVGVycmFmb3JtOiB0ZXJyYWZvcm0sXG4gICAgICAgICAgICAgIFZhcmlhYmxlczogdmFycyxcbiAgICAgICAgICAgICAgUzNCYWNrZW5kQnVja2V0OiB0ZlN0YXRlQnVja2V0LmJ1Y2tldE5hbWUsXG4gICAgICAgICAgICAgIFMzQmFja2VuZEJ1Y2tldFJlZ2lvbjogdGZTdGF0ZUJ1Y2tldC5zdGFjay5yZWdpb24sXG4gICAgICAgICAgICB9LFxuICAgICAgICAgIH0pO1xuICAgICAgICB9XG5cbiAgICAgICAgeyAvLyBBV1PlgbRcbiAgICAgICAgICBjb25zdCBhd3NTdGFjayA9IGNkay5TdGFjay5vZih0aGlzKTtcblxuICAgICAgICAgIGZvciAoY29uc3Qgc291cmNlIG9mIGF3c1N0YWNrLm5vZGUuZmluZEFsbCgpKSB7XG4gICAgICAgICAgICBpZiAoIWNkay5DZm5FbGVtZW50LmlzQ2ZuRWxlbWVudChzb3VyY2UpKSBjb250aW51ZTtcbiAgICAgICAgICAgIGNvbnN0IHRva2VucyA9IGF3c0ZpbmRUb2tlbnMoc291cmNlLCBKU09OLnN0cmluZ2lmeShzb3VyY2UuX3RvQ2xvdWRGb3JtYXRpb24oKSkpO1xuICAgICAgICAgICAgZm9yIChjb25zdCB0b2tlbiBvZiB0b2tlbnMpIHtcbiAgICAgICAgICAgICAgaWYgKCEodG9rZW4gaW5zdGFuY2VvZiBUZkNka1JlZmVyZW5jZSkpIGNvbnRpbnVlO1xuXG4gICAgICAgICAgICAgIC8vIE91dHB1dOOBr0RlcGxveWVy44GuZ2V0QXR044Gn5Y+W5b6X44Gn44GN44KLXG4gICAgICAgICAgICAgIHRva2VuLnZhbHVlID0gdGVycmFmb3JtRGVwbG95ZXIuZ2V0QXR0KHRva2VuLnRmT3V0cHV0TmFtZSk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICB9LFxuICAgIH0pO1xuICB9XG59XG5cbi8qKlxuICogRmluZCBhbGwgVG9rZW5zIHRoYXQgYXJlIHVzZWQgaW4gdGhlIGdpdmVuIHN0cnVjdHVyZVxuICovXG5mdW5jdGlvbiBhd3NGaW5kVG9rZW5zKHNjb3BlOiBjb25zdHJ1Y3RzLklDb25zdHJ1Y3QsIHZhbHVlOiB1bmtub3duKTogY2RrLklSZXNvbHZhYmxlW10ge1xuICBjb25zdCByZXNvbHZlciA9IG5ldyBBd3NSZW1lbWJlcmluZ1Rva2VuUmVzb2x2ZXIobmV3IGNkay5TdHJpbmdDb25jYXQoKSk7XG5cbiAgY2RrLlRva2VuaXphdGlvbi5yZXNvbHZlKHZhbHVlLCB7IHNjb3BlLCByZXNvbHZlciwgcHJlcGFyaW5nOiB0cnVlIH0pO1xuXG4gIHJldHVybiByZXNvbHZlci50b2tlbnM7XG59XG5cbi8qKlxuICogRmluZCBhbGwgVG9rZW5zIHRoYXQgYXJlIHVzZWQgaW4gdGhlIGdpdmVuIHN0cnVjdHVyZVxuICovXG5mdW5jdGlvbiB0ZkZpbmRUb2tlbnMoc2NvcGU6IGNvbnN0cnVjdHMuSUNvbnN0cnVjdCwgdmFsdWU6IHVua25vd24pOiBjZGt0Zi5JUmVzb2x2YWJsZVtdIHtcbiAgY29uc3QgcmVzb2x2ZXIgPSBuZXcgVGZSZW1lbWJlcmluZ1Rva2VuUmVzb2x2ZXIobmV3IGNka3RmLlN0cmluZ0NvbmNhdCgpKTtcblxuICBjZGt0Zi5Ub2tlbml6YXRpb24ucmVzb2x2ZSh2YWx1ZSwgeyBzY29wZSwgcmVzb2x2ZXIsIHByZXBhcmluZzogdHJ1ZSB9KTtcblxuICByZXR1cm4gcmVzb2x2ZXIudG9rZW5zO1xufVxuXG4vKipcbiAqIFJlbWVtYmVyIGFsbCBUb2tlbnMgZW5jb3VudGVyZWQgd2hpbGUgcmVzb2x2aW5nXG4gKi9cbmNsYXNzIEF3c1JlbWVtYmVyaW5nVG9rZW5SZXNvbHZlciBleHRlbmRzIGNkay5EZWZhdWx0VG9rZW5SZXNvbHZlciB7XG4gIHByaXZhdGUgcmVhZG9ubHkgdG9rZW5zU2VlbiA9IG5ldyBTZXQ8Y2RrLklSZXNvbHZhYmxlPigpO1xuXG4gIHB1YmxpYyByZXNvbHZlVG9rZW4oXG4gICAgdDogY2RrLklSZXNvbHZhYmxlLFxuICAgIGNvbnRleHQ6IGNkay5JUmVzb2x2ZUNvbnRleHQsXG4gICAgcG9zdFByb2Nlc3NvcjogY2RrLklQb3N0UHJvY2Vzc29yXG4gICkge1xuICAgIHRoaXMudG9rZW5zU2Vlbi5hZGQodCk7XG4gICAgcmV0dXJuIHN1cGVyLnJlc29sdmVUb2tlbih0LCBjb250ZXh0LCBwb3N0UHJvY2Vzc29yKTtcbiAgfVxuXG4gIHB1YmxpYyByZXNvbHZlU3RyaW5nKHM6IGNkay5Ub2tlbml6ZWRTdHJpbmdGcmFnbWVudHMsIGNvbnRleHQ6IGNkay5JUmVzb2x2ZUNvbnRleHQpIHtcbiAgICByZXR1cm4gc3VwZXIucmVzb2x2ZVN0cmluZyhzLCBjb250ZXh0KTtcbiAgfVxuXG4gIHB1YmxpYyBnZXQgdG9rZW5zKCk6IGNkay5JUmVzb2x2YWJsZVtdIHtcbiAgICByZXR1cm4gQXJyYXkuZnJvbSh0aGlzLnRva2Vuc1NlZW4pO1xuICB9XG59XG5cbi8qKlxuICogUmVtZW1iZXIgYWxsIFRva2VucyBlbmNvdW50ZXJlZCB3aGlsZSByZXNvbHZpbmdcbiAqL1xuY2xhc3MgVGZSZW1lbWJlcmluZ1Rva2VuUmVzb2x2ZXIgZXh0ZW5kcyBjZGt0Zi5EZWZhdWx0VG9rZW5SZXNvbHZlciB7XG4gIHByaXZhdGUgcmVhZG9ubHkgdG9rZW5zU2VlbiA9IG5ldyBTZXQ8Y2RrdGYuSVJlc29sdmFibGU+KCk7XG5cbiAgcHVibGljIHJlc29sdmVUb2tlbihcbiAgICB0OiBjZGt0Zi5JUmVzb2x2YWJsZSxcbiAgICBjb250ZXh0OiBjZGt0Zi5JUmVzb2x2ZUNvbnRleHQsXG4gICAgcG9zdFByb2Nlc3NvcjogY2RrdGYuSVBvc3RQcm9jZXNzb3JcbiAgKSB7XG4gICAgdGhpcy50b2tlbnNTZWVuLmFkZCh0KTtcbiAgICByZXR1cm4gc3VwZXIucmVzb2x2ZVRva2VuKHQsIGNvbnRleHQsIHBvc3RQcm9jZXNzb3IpO1xuICB9XG5cbiAgcHVibGljIHJlc29sdmVTdHJpbmcoczogY2RrdGYuVG9rZW5pemVkU3RyaW5nRnJhZ21lbnRzLCBjb250ZXh0OiBjZGt0Zi5JUmVzb2x2ZUNvbnRleHQpIHtcbiAgICByZXR1cm4gc3VwZXIucmVzb2x2ZVN0cmluZyhzLCBjb250ZXh0KTtcbiAgfVxuXG4gIHB1YmxpYyBnZXQgdG9rZW5zKCk6IGNka3RmLklSZXNvbHZhYmxlW10ge1xuICAgIHJldHVybiBBcnJheS5mcm9tKHRoaXMudG9rZW5zU2Vlbik7XG4gIH1cbn1cblxuY2xhc3MgQXdzQ2RrUmVmZXJlbmNlIGltcGxlbWVudHMgY2RrdGYuSVJlc29sdmFibGUge1xuICBjcmVhdGlvblN0YWNrID0gW107XG4gIGNhY2hlOiB1bmtub3duO1xuICB0ZlZhcmlhYmxlTmFtZTogc3RyaW5nO1xuICBjb25zdHJ1Y3RvcihyZWFkb25seSByZWY6IGNkay5SZWZlcmVuY2UpIHtcbiAgICBjb25zdCB0b2tlbk51bSA9IC9cXFtUT0tFTlxcLihcXGQrKVxcXS8uZXhlYyhyZWYudG9TdHJpbmcoKSk/LlsxXTtcbiAgICBpZiAodG9rZW5OdW0gPT0gdW5kZWZpbmVkKSBjb25zb2xlLndhcm4oYEZhaWxlZCB0byBkZXRlY3QgdG9rZW4gbnVtYmVyIGZyb20gdG9rZW4gJHtyZWYudG9TdHJpbmcoKX1gKTtcblxuICAgIHRoaXMudGZWYXJpYWJsZU5hbWUgPSBgY2RrLSR7dGhpcy5yZWYuZGlzcGxheU5hbWV9LSR7dG9rZW5OdW19YDtcbiAgfVxuICByZXNvbHZlKGNvbnRleHQ6IGNka3RmLklSZXNvbHZlQ29udGV4dCkge1xuICAgIGlmICh0aGlzLmNhY2hlICE9PSB1bmRlZmluZWQpIHJldHVybiB0aGlzLmNhY2hlOyAvLyBjb250ZXh0LnNjb3Bl44GM6YGV44Gj44Gf44KJ44Gp44GG44GZ44KL77yfXG5cbiAgICBsZXQgaW5wdXRUeXBlOiBzdHJpbmcgfCB1bmRlZmluZWQgPSB1bmRlZmluZWQ7XG4gICAgc3dpdGNoICh0aGlzLnJlZi50eXBlSGludCkge1xuICAgICAgY2FzZSBjZGsuUmVzb2x1dGlvblR5cGVIaW50Lk5VTUJFUjpcbiAgICAgICAgaW5wdXRUeXBlID0gJ251bWJlcic7XG4gICAgICAgIGJyZWFrO1xuICAgICAgY2FzZSBjZGsuUmVzb2x1dGlvblR5cGVIaW50LlNUUklORzpcbiAgICAgICAgaW5wdXRUeXBlID0gJ3N0cmluZyc7XG4gICAgICAgIGJyZWFrO1xuICAgICAgY2FzZSBjZGsuUmVzb2x1dGlvblR5cGVIaW50LlNUUklOR19MSVNUOlxuICAgICAgICBpbnB1dFR5cGUgPSAnbGlzdChzdHJpbmcpJztcbiAgICAgICAgYnJlYWs7XG4gICAgfVxuXG4gICAgY29uc3QgaW5wdXQgPSBuZXcgY2RrdGYuVGVycmFmb3JtVmFyaWFibGUoY2RrdGYuVGVycmFmb3JtU3RhY2sub2YoY29udGV4dC5zY29wZSksIHRoaXMudGZWYXJpYWJsZU5hbWUsIHtcbiAgICAgIHR5cGU6IGlucHV0VHlwZSxcbiAgICAgIG51bGxhYmxlOiBmYWxzZSxcbiAgICB9KTtcblxuICAgIHRoaXMuY2FjaGUgPSBpbnB1dC52YWx1ZTtcblxuICAgIHJldHVybiBpbnB1dC52YWx1ZTtcbiAgfVxuICB0b1N0cmluZygpOiBzdHJpbmcge1xuICAgIHJldHVybiB0aGlzLnJlZi50b1N0cmluZygpO1xuICB9XG59XG5cbmNsYXNzIFRmQ2RrUmVmZXJlbmNlIGltcGxlbWVudHMgY2RrLklSZXNvbHZhYmxlIHtcbiAgY3JlYXRpb25TdGFjayA9IFtdO1xuICB0Zk91dHB1dE5hbWU6IHN0cmluZztcbiAgdmFsdWU/OiB1bmtub3duO1xuICBjb25zdHJ1Y3RvcihyZWFkb25seSByZXNvbHZhYmxlOiBjZGt0Zi5JUmVzb2x2YWJsZSkge1xuICAgIGNvbnN0IHRva2VuTnVtID0gL1xcW1RPS0VOXFwuKFxcZCspXFxdLy5leGVjKHJlc29sdmFibGUudG9TdHJpbmcoKSk/LlsxXTtcbiAgICBpZiAodG9rZW5OdW0gPT0gdW5kZWZpbmVkKSBjb25zb2xlLndhcm4oYEZhaWxlZCB0byBkZXRlY3QgdG9rZW4gbnVtYmVyIGZyb20gdG9rZW4gJHtyZXNvbHZhYmxlLnRvU3RyaW5nKCl9YCk7XG5cbiAgICB0aGlzLnRmT3V0cHV0TmFtZSA9IGBjZGstb3V0LSR7dG9rZW5OdW19YDtcbiAgfVxuICByZXNvbHZlKCkge1xuICAgIC8vIGNvbnN0IG91dHB1dCA9IG5ldyBjZGt0Zi5UZXJyYWZvcm1PdXRwdXQoY2RrdGYuVGVycmFmb3JtU3RhY2sub2YoY29udGV4dC5zY29wZSksIHRoaXMuY2RrVmFyaWFibGVOYW1lLCB7XG4gICAgLy8gICB0eXBlOiBpbnB1dFR5cGUsXG4gICAgLy8gICBudWxsYWJsZTogZmFsc2UsXG4gICAgLy8gfSk7XG4gICAgaWYgKCF0aGlzLnZhbHVlKSB7XG4gICAgICByZXR1cm4gJzx1bmRldGVybWluZWQ+JztcbiAgICB9XG4gICAgcmV0dXJuIHRoaXMudmFsdWU7XG4gIH1cbiAgdG9TdHJpbmcoKTogc3RyaW5nIHtcbiAgICByZXR1cm4gdGhpcy5yZXNvbHZhYmxlLnRvU3RyaW5nKCk7XG4gIH1cbn1cblxuZXhwb3J0IGZ1bmN0aW9uIHRva2VuU3RyaW5nRnJvbUF3c1RvVGVycmFmb3JtKG9yaWc6IHN0cmluZyk6IHN0cmluZyB7XG4gIGlmICghY2RrLlRva2VuLmlzVW5yZXNvbHZlZChvcmlnKSkgcmV0dXJuIG9yaWc7XG5cbiAgY29uc3QgZnJhZ21lbnRzID0gY2RrLlRva2VuaXphdGlvbi5yZXZlcnNlU3RyaW5nKG9yaWcpO1xuICBjb25zdCB0ZkZyYWdtZW50cyA9IGZyYWdtZW50cy5tYXBUb2tlbnMoe1xuICAgIG1hcFRva2VuKHQpIHtcbiAgICAgIGlmIChjZGsuUmVmZXJlbmNlLmlzUmVmZXJlbmNlKHQpKSB7XG4gICAgICAgIHJldHVybiBjZGt0Zi5Ub2tlbi5hc1N0cmluZyhuZXcgQXdzQ2RrUmVmZXJlbmNlKHQpKTtcbiAgICAgIH1cblxuICAgICAgcmV0dXJuIHQ7XG4gICAgfSxcbiAgfSk7XG5cbiAgcmV0dXJuIHRmRnJhZ21lbnRzLmpvaW4obmV3IGNkay5TdHJpbmdDb25jYXQoKSk7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiB0b2tlblN0cmluZ0Zyb21UZXJyYWZvcm1Ub0F3cyhvcmlnOiBzdHJpbmcpOiBzdHJpbmcge1xuICBpZiAoIWNka3RmLlRva2VuLmlzVW5yZXNvbHZlZChvcmlnKSkgcmV0dXJuIG9yaWc7XG5cbiAgY29uc3QgdGZGcmFnbWVudHMgPSBjZGt0Zi5Ub2tlbml6YXRpb24ucmV2ZXJzZVN0cmluZyhvcmlnKTtcbiAgY29uc3QgZnJhZ21lbnRzID0gdGZGcmFnbWVudHMubWFwVG9rZW5zKHtcbiAgICByZXNvbHZlKHgpIHtcbiAgICAgIGlmIChjZGt0Zi5Ub2tlbml6YXRpb24uaXNSZXNvbHZhYmxlKHgpKSB7XG4gICAgICAgIHJldHVybiBjZGsuVG9rZW4uYXNTdHJpbmcobmV3IFRmQ2RrUmVmZXJlbmNlKHgpKTtcbiAgICAgIH1cblxuICAgICAgcmV0dXJuIHg7XG4gICAgfSxcbiAgICBzY29wZTogdW5kZWZpbmVkIGFzIGFueSwgLy8gQWN0dWFsbHkgbm90IHVzZWQuXG4gICAgcHJlcGFyaW5nOiB0cnVlLFxuICAgIHJlZ2lzdGVyUG9zdFByb2Nlc3NvcjogdW5kZWZpbmVkIGFzIGFueSwgLy8gQWN0dWFsbHkgbm90IHVzZWQuXG4gIH0pO1xuXG4gIHJldHVybiBmcmFnbWVudHMuam9pbihuZXcgY2RrdGYuU3RyaW5nQ29uY2F0KCkpO1xufVxuXG5mdW5jdGlvbiBzaW5nbGV0b25SZXNvdXJjZTxUIGV4dGVuZHMgY29uc3RydWN0cy5JQ29uc3RydWN0PihzY29wZTogY29uc3RydWN0cy5JQ29uc3RydWN0LCBnbG9iYWxJZDogc3RyaW5nLCBmYWN0b3J5OiAoKSA9PiBUKTogVCB7XG4gIGNvbnN0IHN0YWNrID0gY2RrLlN0YWNrLm9mKHNjb3BlKTtcbiAgY29uc3QgZXhpc3RpbmcgPSBzdGFjay5ub2RlLnRyeUZpbmRDaGlsZChnbG9iYWxJZCk7XG4gIGlmIChleGlzdGluZykgcmV0dXJuIGV4aXN0aW5nIGFzIFQ7XG4gIHJldHVybiBmYWN0b3J5KCk7XG59XG4iXX0=