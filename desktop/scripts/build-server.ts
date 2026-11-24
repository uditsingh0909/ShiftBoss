// Compiles the ShiftBoss server into one executable that Tauri ships as a sidecar.
// Tauri looks for binaries/shiftboss-server-<target triple>[.exe].
import { join } from 'node:path';

const triple = process.env.TAURI_ENV_TARGET_TRIPLE ?? (await (async () => {
  const out = await new Response(Bun.spawn(['rustc', '-vV'], { stdout: 'pipe' }).stdout).text();
  const host = out.match(/^host: (.+)$/m)?.[1];
  if (!host) throw new Error('Could not read the Rust host triple from `rustc -vV`');
  return host.trim();
})());

const bunTarget: Record<string, string> = {
  'x86_64-pc-windows-msvc': 'bun-windows-x64',
  'x86_64-apple-darwin': 'bun-darwin-x64',
  'aarch64-apple-darwin': 'bun-darwin-arm64',
  'x86_64-unknown-linux-gnu': 'bun-linux-x64',
  'aarch64-unknown-linux-gnu': 'bun-linux-arm64',
};
const target = bunTarget[triple];
if (!target) throw new Error('No Bun target for ' + triple);

const ext = triple.includes('windows') ? '.exe' : '';
const outfile = join(import.meta.dir, '..', 'src-tauri', 'binaries', `shiftboss-server-${triple}${ext}`);
const proc = Bun.spawn(['bun', 'build', '--compile', '--minify', `--target=${target}`, join(import.meta.dir, '..', '..', 'server', 'index.ts'), '--outfile', outfile], { stdout: 'inherit', stderr: 'inherit' });
if ((await proc.exited) !== 0) process.exit(1);
console.log('server sidecar →', outfile);
