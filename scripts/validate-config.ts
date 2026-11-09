import { readFile } from 'node:fs/promises';
import { parseConfigYaml, AutosError } from '@autos/contracts';

try {
  const config = parseConfigYaml(await readFile(process.argv[2] ?? 'config/config.example.yaml', 'utf8'));
  console.log(`Configuration valid: schema ${config.schema_version}; ${config.bitbucket.allowed_repositories.length} allowed repository configuration(s). Credential presence is not checked.`);
} catch (error) {
  console.error(error instanceof AutosError ? `${error.code}: ${error.message}` : 'Unable to read configuration');
  process.exitCode = 1;
}
