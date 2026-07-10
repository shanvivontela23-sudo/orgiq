# SF Copilot External Client App Packaging

This workspace is intentionally disabled for now. The metadata is preserved for the future packaged External Client App path, but `sfdx-project.json` has no active `packageDirectories`, so package commands will not run accidentally.

## Why It Is Disabled

Salesforce rejected package version creation from the current Developer Edition app origin:

```text
External client apps that are created in ephemeral orgs can't be packaged.
```

We deployed the required Dev Hub setting successfully:

```xml
<enablePackageEcaOauthFromDevOrg>true</enablePackageEcaOauthFromDevOrg>
```

The remaining product-grade path is to create the External Client App in a proper non-ephemeral publisher org / namespaced packaging org, then create a 2GP managed package from there.

## Preserved Metadata

- `force-app/main/default/externalClientApps/SF_Copilot.eca-meta.xml`
- `force-app/main/default/extlClntAppOauthSettings/SF_Copilot_oauth.ecaOauth-meta.xml`
- `config-metadata/main/default/settings/ExternalClientApp.settings-meta.xml`
- `manifest/package.xml`

## Re-enable Later

When we have a proper publisher org and namespace, restore `sfdx-project.json` to:

```json
{
  "packageDirectories": [
    {
      "path": "force-app",
      "default": true,
      "package": "SF Copilot",
      "versionName": "ver 0.1",
      "versionNumber": "0.1.0.NEXT"
    }
  ],
  "name": "sf-copilot-package",
  "namespace": "<publisher_namespace>",
  "sfdcLoginUrl": "https://login.salesforce.com",
  "sourceApiVersion": "66.0",
  "packageAliases": {}
}
```

Then run:

```bash
sf project deploy start --target-org <publisher-org> --source-dir config-metadata/main/default/settings/ExternalClientApp.settings-meta.xml --wait 10
sf package create --name "SF Copilot" --package-type Managed --path force-app --target-dev-hub <publisher-devhub>
sf package version create --package "SF Copilot" --installation-key-bypass --definition-file config/project-scratch-def.json --target-dev-hub <publisher-devhub> --wait 30
sf package install --package <04t-package-version-id> --target-org <target-org> --wait 30
```
