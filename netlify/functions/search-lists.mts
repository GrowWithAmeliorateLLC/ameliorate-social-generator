import type { Context } from "@netlify/functions";

export default async (req: Request, _context: Context) => {
  const { searchParams } = new URL(req.url);
  const query = searchParams.get("q")?.trim() ?? "";

  if (!query || query.length < 2) {
    return new Response(JSON.stringify([]), { headers: { "Content-Type": "application/json" } });
  }

  const token = Netlify.env.get("CLICKUP_API_TOKEN") ?? "";
  const workspaceId = Netlify.env.get("CLICKUP_WORKSPACE_ID") ?? "";

  if (!token || !workspaceId) {
    return new Response(
      JSON.stringify({ error: "ClickUp credentials not configured" }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }

  try {
    const v3Res = await fetch(
      `https://api.clickup.com/api/v3/workspaces/${workspaceId}/search?query=${encodeURIComponent(query)}&types=list`,
      { headers: { Authorization: token } }
    );

    if (v3Res.ok) {
      const data = await v3Res.json();
      const lists = (data.results ?? [])
        .filter((r: any) => r.type === "list")
        .map((r: any) => ({
          id: r.id,
          name: r.name,
          path: r.folder?.name ? `${r.space?.name ?? ""} › ${r.folder.name} › ${r.name}` : `${r.space?.name ?? ""} › ${r.name}`,
        }));
      return new Response(JSON.stringify(lists), { headers: { "Content-Type": "application/json" } });
    }

    const matches = await searchHierarchy(token, workspaceId, query);
    return new Response(JSON.stringify(matches), { headers: { "Content-Type": "application/json" } });
  } catch (err: any) {
    return new Response(
      JSON.stringify({ error: err.message ?? "Search failed" }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
};

async function searchHierarchy(token: string, workspaceId: string, query: string): Promise<any[]> {
  const lq = query.toLowerCase();
  const matches: any[] = [];

  const spacesRes = await fetch(
    `https://api.clickup.com/api/v2/team/${workspaceId}/space?archived=false`,
    { headers: { Authorization: token } }
  );
  if (!spacesRes.ok) return [];

  const { spaces = [] } = await spacesRes.json();

  await Promise.all(spaces.map(async (space: any) => {
    const fRes = await fetch(
      `https://api.clickup.com/api/v2/space/${space.id}/folder?archived=false`,
      { headers: { Authorization: token } }
    );
    if (fRes.ok) {
      const { folders = [] } = await fRes.json();
      await Promise.all(folders.map(async (folder: any) => {
        const lRes = await fetch(
          `https://api.clickup.com/api/v2/folder/${folder.id}/list?archived=false`,
          { headers: { Authorization: token } }
        );
        if (lRes.ok) {
          const { lists = [] } = await lRes.json();
          lists.filter((l: any) => l.name.toLowerCase().includes(lq))
            .forEach((l: any) => matches.push({ id: l.id, name: l.name, path: `${space.name} › ${folder.name} › ${l.name}` }));
        }
      }));
    }
    const flRes = await fetch(
      `https://api.clickup.com/api/v2/space/${space.id}/list?archived=false`,
      { headers: { Authorization: token } }
    );
    if (flRes.ok) {
      const { lists = [] } = await flRes.json();
      lists.filter((l: any) => l.name.toLowerCase().includes(lq))
        .forEach((l: any) => matches.push({ id: l.id, name: l.name, path: `${space.name} › ${l.name}` }));
    }
  }));

  return matches;
}

export const config = { path: "/api/search-lists" };
