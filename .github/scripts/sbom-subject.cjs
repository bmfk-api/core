// `npm sbom -w @bmfk/api` describes the monorepo root (private, 0.0.0) and lists @bmfk/api as one of its
// components. The SBOM attached to a release is about the package: make @bmfk/api the subject and drop the
// root. Usage: node .github/scripts/sbom-subject.cjs sbom.cdx.json
const fs = require("fs");
const file = process.argv[2];
const pkg = require("../../packages/api/package.json");

const bom = JSON.parse(fs.readFileSync(file, "utf-8"));
const ref = `${pkg.name}@${pkg.version}`;
const self = bom.components.find(c => c["bom-ref"] === ref);
if (!self) throw new Error(`${ref} is not in the SBOM`);
const root = bom.metadata.component["bom-ref"];
bom.metadata.component = self;
bom.components = bom.components.filter(c => c !== self);
bom.dependencies = bom.dependencies.filter(d => d.ref !== root);
fs.writeFileSync(file, JSON.stringify(bom, null, 2) + "\n");
