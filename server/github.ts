// Moves tasks forward from what GitHub and the release endpoints already say, so a
// session only has to report the last step (requester told).
//
//   PR mentioning T-12 is open            -> T-12 at least "PR open"
//   that PR merged                        -> logged; stays "PR open" until it ships
//   dev's deployed commit includes merge  -> "On dev"
//   prod's deployed commit includes merge -> "Live"
//
// Never moves a task backwards and never sets "Requester told" (only a person knows that).

export interface PrInfo { url: string; repo: string; number: number; title: string; body: string; branch: string; state: 'OPEN' | 'MERGED' | 'CLOSED'; mergeSha: string | null }

/** Task ids named in a PR's title, body or branch: "T-12", "t-12", "t12-fix" are all T-12. */
export function taskIdsIn(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/(?<![A-Za-z0-9])T-?(\d{1,6})(?![0-9])/gi)) out.add('T-' + Number(m[1]));
  return [...out];
}

export function parsePrUrl(url: string): { repo: string; number: number } | null {
  const m = url.match(/^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/);
  return m ? { repo: m[1], number: Number(m[2]) } : null;
}

/** The stage a task should be at, given its PR and which environments contain the merge. */
export function targetStage(pr: Pick<PrInfo, 'state'>, onDev: boolean, onProd: boolean): number | null {
  if (pr.state === 'CLOSED') return null;
  if (pr.state === 'OPEN') return 3;
  if (onProd) return 5;
  if (onDev) return 4;
  return 3;
}

async function gh(args: string[], token?: string): Promise<string> {
  const proc = Bun.spawn(['gh', ...args], { stdout: 'pipe', stderr: 'pipe', env: token ? { ...process.env, GH_TOKEN: token } : process.env });
  const timer = setTimeout(() => proc.kill(), 15000);
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  clearTimeout(timer);
  if (code !== 0) throw new Error(err.trim() || 'gh exited ' + code);
  return out;
}

export async function fetchPr(url: string): Promise<PrInfo | null> {
  const p = parsePrUrl(url);
  if (!p) return null;
  const j = JSON.parse(await gh(['pr', 'view', String(p.number), '--repo', p.repo, '--json', 'number,title,body,headRefName,state,mergeCommit']));
  return { url, repo: p.repo, number: j.number, title: j.title ?? '', body: j.body ?? '', branch: j.headRefName ?? '', state: j.state, mergeSha: j.mergeCommit?.oid ?? null };
}

/** True when `deployedSha` already contains `mergeSha` (compare says the deploy is ahead or identical). */
export async function contains(repo: string, mergeSha: string, deployedSha: string): Promise<boolean> {
  if (!/^[0-9a-f]{7,40}$/i.test(deployedSha)) return false;
  const status = (await gh(['api', `repos/${repo}/compare/${mergeSha}...${deployedSha}`, '--jq', '.status'])).trim();
  return status === 'ahead' || status === 'identical';
}
