# Azure deployment setup (one-time)

Files here are **templates with `<PLACEHOLDERS>`**. Nothing is deployed until you create the Azure resources and set the GitHub variables. Review every command before running it, and prefer Bicep/Terraform for anything long-lived.

1. **Resource group and registry:**
   `az group create -n <RESOURCE_GROUP> -l <REGION>`
   `az acr create -g <RESOURCE_GROUP> -n <ACR_NAME> --sku Basic --admin-enabled false`
2. **Deploy identity (no secret):**
   `az ad app create --display-name github-deploy` (note the `appId`)
   `az ad sp create --id <APP_ID>`
   `az ad app federated-credential create --id <APP_ID> --parameters @infra/azure/federated-credential.json` (fill in owner and repo first)
3. **Least-privilege roles, scoped to the resource group (not the subscription):**
   `az role assignment create --assignee <APP_ID> --role AcrPush --scope <ACR_RESOURCE_ID>`
   `az role assignment create --assignee <APP_ID> --role Contributor --scope /subscriptions/<SUBSCRIPTION_ID>/resourceGroups/<RESOURCE_GROUP>`
4. **Container Apps environment + app:** create with a **managed identity**; pull from ACR with that identity (no admin credentials).
5. **Secrets:** keep them in **Key Vault** and reference them from the app (Key Vault references with the managed identity). In code use `DefaultAzureCredential`, never connection strings with keys.
6. **Networking:** databases and storage with **public network access disabled** and private endpoints where possible; HTTPS only; TLS 1.2 minimum.
7. **Logs and alerts:** Log Analytics + Application Insights, an alert on failed requests, and a Cost Management budget.
8. **GitHub variables:** `AZURE_CLIENT_ID` (the appId), `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID`, `ACR_NAME`, `APP_NAME`, `RESOURCE_GROUP`. Add required reviewers to the `production` environment.

Rollback: `az containerapp revision list` then `az containerapp ingress traffic set --revision-weight <previous>=100`.
