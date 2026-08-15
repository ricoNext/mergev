import { build } from "./build.mjs";
import { mkdir, cp, readFile, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
await build;
const root = fileURLToPath(new URL(".", import.meta.url));
const extensionManifest = JSON.parse(
	await readFile(`${root}package.json`, "utf8"),
);
const staging = `${root}.vsix-staging`;
const output = `${root}${extensionManifest.name}-${extensionManifest.version}.vsix`;
await Promise.all([
  rm(staging, { recursive: true, force: true }),
  rm(output, { force: true }),
]);
await mkdir(`${staging}/extension/dist`, { recursive: true });
await mkdir(`${staging}/extension/media`, { recursive: true });
await mkdir(`${staging}/extension/bin/darwin-arm64`, { recursive: true });
await mkdir(`${staging}/extension/bin/darwin-x64`, { recursive: true });
await cp(`${root}package.json`, `${staging}/extension/package.json`);
await cp(`${root}README.md`, `${staging}/extension/README.md`);
await cp(`${root}CHANGELOG.md`, `${staging}/extension/CHANGELOG.md`);
await cp(`${root}LICENSE`, `${staging}/extension/LICENSE`);
await cp(`${root}dist`, `${staging}/extension/dist`, { recursive: true });
await cp(`${root}media`, `${staging}/extension/media`, { recursive: true });
await cp(`${root}bin/darwin-arm64/mergev-sidecar`, `${staging}/extension/bin/darwin-arm64/mergev-sidecar`);
await cp(`${root}bin/darwin-x64/mergev-sidecar`, `${staging}/extension/bin/darwin-x64/mergev-sidecar`);
await writeFile(
  `${staging}/[Content_Types].xml`,
  `<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="json" ContentType="application/json"/>
  <Default Extension="js" ContentType="application/javascript"/>
  <Default Extension="svg" ContentType="image/svg+xml"/>
  <Default Extension="png" ContentType="image/png"/>
  <Default Extension="md" ContentType="text/markdown"/>
  <Default Extension="vsixmanifest" ContentType="text/xml"/>
  <Default Extension="xml" ContentType="text/xml"/>
  <Default Extension="map" ContentType="application/json"/>
  <Default Extension="" ContentType="application/octet-stream"/>
</Types>
`,
);
await writeFile(
  `${staging}/extension.vsixmanifest`,
  `<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011">
  <Metadata>
    <Identity Id="${extensionManifest.name}" Version="${extensionManifest.version}" Language="en" Publisher="${extensionManifest.publisher}"/>
    <DisplayName>mergev</DisplayName>
    <Description xml:space="preserve">使用 mergev 三栏界面解决 Git 冲突</Description>
    <Tags>scm,git,merge,conflict</Tags>
    <Categories>SCM Providers</Categories>
    <GalleryFlags>Public</GalleryFlags>
    <Properties>
      <Property Id="Microsoft.VisualStudio.Services.Links.Source" Value="https://github.com/ricoNext/mergev.git"/>
      <Property Id="Microsoft.VisualStudio.Services.Links.Getstarted" Value="https://github.com/ricoNext/mergev.git"/>
      <Property Id="Microsoft.VisualStudio.Services.Links.GitHub" Value="https://github.com/ricoNext/mergev.git"/>
      <Property Id="Microsoft.VisualStudio.Services.Links.Support" Value="https://github.com/ricoNext/mergev/issues"/>
      <Property Id="Microsoft.VisualStudio.Code.Engine" Value="^1.85.0"/>
      <Property Id="Microsoft.VisualStudio.Services.GitHubFlavoredMarkdown" Value="true"/>
    </Properties>
  </Metadata>
  <Installation>
    <InstallationTarget Id="Microsoft.VisualStudio.Code" Version="^1.85.0"/>
  </Installation>
  <Dependencies/>
  <Assets>
    <Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json"/>
    <Asset Type="Microsoft.VisualStudio.Services.Content.Details" Path="extension/README.md"/>
    <Asset Type="Microsoft.VisualStudio.Services.Content.Changelog" Path="extension/CHANGELOG.md"/>
    <Asset Type="Microsoft.VisualStudio.Services.Content.License" Path="extension/LICENSE"/>
    <Asset Type="Microsoft.VisualStudio.Services.Icons.Default" Path="extension/media/icon.png"/>
    <Asset Type="Microsoft.VisualStudio.Services.Content" Path="extension"/>
  </Assets>
</PackageManifest>
`,
);
await exec("zip", ["-qr", output, "."], { cwd: staging });
console.log(`已生成 ${output}`);
