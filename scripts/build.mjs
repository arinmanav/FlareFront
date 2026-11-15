import { cp, lstat, mkdir, readdir, readFile, realpath, rm, stat } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateRegions, validateRegionalDashboard } from '../web/regions.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(root, 'web');
const destination = resolve(root, 'dist');
const runtimeFiles = ['index.html', 'styles.css', 'app.js', 'calendar.js', 'exports.js', 'harmonization.js', 'comparison.js', 'regions.js', 'area.js', 'area-controls.js'];
const runtimeDirectories = ['assets', 'data', 'vendor', 'figures'];
const notices = ['LICENSE', 'NOTICE', 'THIRD_PARTY_NOTICES'];
const requiredData = ['dashboard.json', 'points.json', 'county.geojson', 'hotspots.csv', 'calendar.csv', 'regions.json', 'harmonization-study.json'];
const requiredVendor = ['plotly.min.js', 'leaflet.js', 'leaflet.css'];

async function regularFiles(directory, prefix = '') {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw new Error(`Distribution input cannot be a symbolic link: ${join(prefix, entry.name)}`);
    if (entry.isDirectory()) files.push(...await regularFiles(join(directory, entry.name), join(prefix, entry.name)));
    else if (entry.isFile()) files.push(join(prefix, entry.name));
    else throw new Error(`Unsupported distribution input: ${entry.name}`);
  }
  return files;
}

async function build() {
  const targetRelative = relative(root, destination);
  if (targetRelative !== 'dist' || destination === root || targetRelative.startsWith(`..${sep}`)) throw new Error('Build output must be the project dist directory.');
  for (const name of runtimeFiles) if (!(await stat(join(source, name))).isFile()) throw new Error(`Missing runtime source ${name}`);
  for (const name of requiredData) if (!(await stat(join(source, 'data', name))).isFile()) throw new Error(`Missing runtime data ${name}`);
  const registry = validateRegions(JSON.parse(await readFile(join(source, 'data/regions.json'), 'utf8')));
  for (const region of registry.regions) {
    for (const name of ['dashboard.json', 'points.json', 'county.geojson', 'calendar.csv', 'hotspots.csv']) {
      if (!(await stat(join(source, region.data_path, name))).isFile()) throw new Error(`Missing ${region.city} record: ${name}`);
    }
    validateRegionalDashboard(JSON.parse(await readFile(join(source, region.data_path, 'dashboard.json'), 'utf8')), region);
  }
  for (const name of requiredVendor) if (!(await stat(join(source, 'vendor', name))).isFile()) throw new Error(`Missing local vendor asset ${name}`);
  for (const method of ['raw', 'ratio', 'spatial_ratio']) for (const view of ['3d', '2d']) for (const format of ['png', 'svg']) {
    const name = `harmonization_${method}_${view}.${format}`;
    if (!(await stat(join(source, 'figures', name))).isFile()) throw new Error(`Missing comparison figure ${name}`);
  }
  for (const name of notices) if (!(await stat(join(root, name))).isFile()) throw new Error(`Missing distribution notice ${name}`);
  const directoryFiles = new Map();
  for (const directory of runtimeDirectories) directoryFiles.set(directory, (await regularFiles(join(source, directory))).filter((name) => !(directory === 'data' && ['historical-response.json', 'training-scenario.json', 'decision-scenario-template.json', 'prediction.json', 'decision-inputs.json', 'emit-ndwi.json'].includes(basename(name)))));
  const allowedExtensions = /\.(?:json|geojson|csv|js|css|png|gif|svg|txt|map|woff2?|ttf|html)$/i;
  for (const [directory, files] of directoryFiles) for (const name of files) {
    if ((!allowedExtensions.test(name) && !/^(?:[A-Z]+-)?(?:LICENSE|COPYING|NOTICE)(?:\..*)?$/i.test(basename(name))) || name.split(/[\\/]/).some((part) => part.startsWith('.'))) throw new Error(`Unexpected runtime file: ${directory}/${name}`);
  }
  try {
    if ((await lstat(destination)).isSymbolicLink() || relative(await realpath(root), await realpath(destination)) !== 'dist') throw new Error('Build output resolves outside the project dist directory.');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  await rm(destination, { recursive: true, force: true });
  await mkdir(destination, { recursive: true });
  for (const name of runtimeFiles) await cp(join(source, name), join(destination, name));
  for (const directory of runtimeDirectories) for (const name of directoryFiles.get(directory)) {
    const target = join(destination, directory, name);
    await mkdir(dirname(target), { recursive: true });
    await cp(join(source, directory, name), target);
  }
  for (const name of notices) await cp(join(root, name), join(destination, name));
  const dashboard = JSON.parse(await readFile(join(destination, 'data/dashboard.json'), 'utf8'));
  console.log(`Built ${destination}: ${runtimeFiles.length + notices.length + [...directoryFiles.values()].reduce((sum, files) => sum + files.length, 0)} files, ${registry.regions.length} county records, ${dashboard.months.length} months per calendar.`);
}

build().catch((error) => { console.error(`Build failed: ${error.message}`); process.exitCode = 1; });
