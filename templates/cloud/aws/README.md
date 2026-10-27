# AWS deployment setup (one-time)

Files here are **templates with `<PLACEHOLDERS>`**. Nothing is deployed until you create the AWS resources and set the GitHub variables. Review every command before running it, and prefer Terraform/CDK for anything long-lived.

1. **Container image repo:** `aws ecr create-repository --repository-name <ECR_REPOSITORY> --image-scanning-configuration scanOnPush=true`
2. **GitHub OIDC provider (once per account):** `aws iam create-open-id-connect-provider --url https://token.actions.githubusercontent.com --client-id-list sts.amazonaws.com`
3. **Deploy role:** create an IAM role with `github-oidc-trust-policy.json` as its trust policy (fill in account, owner, repo) and attach `ecr-ecs-deploy-policy.json`. Keep it least-privilege: only your repository, only the `main` branch.
4. **ECS:** create a Fargate cluster and service in **private subnets**, behind an ALB. Keep databases in private subnets with no public access; allow only the app's security group to reach them.
5. **Secrets:** put them in Secrets Manager or SSM Parameter Store and reference them in the task definition `secrets` block. Never in `environment`, the image, or the repo.
6. **Logs and alarms:** CloudWatch log group `/ecs/app`, an alarm on 5xx/unhealthy targets, and an AWS Budget alert.
7. **GitHub variables** (Settings > Secrets and variables > Variables): `AWS_ROLE_ARN`, `AWS_REGION`, `ECR_REPOSITORY`, `ECS_CLUSTER`, `ECS_SERVICE`. Add required reviewers to the `production` environment.

Rollback: re-run the workflow on a previous commit, or `aws ecs update-service --cluster <C> --service <S> --task-definition <previous revision>`.
