import type { Context } from "@netlify/functions";

const TEXT_CUSTOM_FIELD_ID = "93af8cc2-fa4a-4b54-b482-8451264eb4a2";

export default async (req: Request, _context: Context) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  try {
    const { url, clientName, listId } = await req.json();

    if (!url || !clientName || !listId) {
      return new Response(
        JSON.stringify({ error: "Missing required fields: url, clientName, listId" }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    // 1. Scrape page via Jina AI Reader (handles JS-rendered sites)
    const jinaUrl = `https://r.jina.ai/${url}`;
    let pageContent = "";

    try {
      const pageRes = await fetch(jinaUrl, {
        headers: { Accept: "text/plain", "X-Return-Format": "text", "X-Timeout": "15" },
        signal: AbortSignal.timeout(20000),
      });
      pageContent = await pageRes.text();
    } catch {
      const fallbackRes = await fetch(url, {
        headers: { "User-Agent": "Mozilla/5.0 (compatible; AmeliorateBot/1.0)" },
        signal: AbortSignal.timeout(10000),
      });
      const html = await fallbackRes.text();
      pageContent = html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
    }

    if (!pageContent || pageContent.length < 80) {
      return new Response(
        JSON.stringify({ error: "Could not extract enough content from URL. Please check the link and try again." }),
        { status: 422, headers: { "Content-Type": "application/json" } }
      );
    }

    const contentSnippet = pageContent.substring(0, 5000);

    // 2. Generate 3 posts + content theme via Claude API
    const anthropicKey = Netlify.env.get("ANTHROPIC_API_KEY");
    const claudeRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": anthropicKey ?? "",
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 2000,
        messages: [{
          role: "user",
          content: `You are a social media expert for youth enrichment and kids' activity businesses.

Using the website content below for a client called "${clientName}", write exactly 3 distinct Facebook/Instagram posts.

TARGET AUDIENCE: Parents and mothers with children ages 5–14 who are actively searching for enriching, fun, educational activities for their kids.

TONE: Warm, community-focused, enthusiastic but not salesy. Lead with the child's benefit or a relatable parent moment. Use 2–3 emojis naturally woven in—never in a row or forced.

RULES:
- Each post must feel distinct (one curiosity-based, one social-proof/results, one urgency/event-driven)
- Keep captions 100–140 words
- No generic phrases like "unlock potential" or "don't miss out"
- Hashtags should be locally relevant where possible

Also identify 1–2 short content theme words that best describe the main topic of this page (e.g. BIRTHDAY, CODING, SUMMER CAMP, AFTER SCHOOL, ROBOTICS, STEM, PARTIES). Use ALL CAPS, 1–3 words max, keep it punchy.

WEBSITE CONTENT:
${contentSnippet}

Return ONLY a valid JSON object—no markdown fences, no explanation. Schema:
{
  "theme": "BIRTHDAY PARTIES",
  "posts": [
    {
      "hook": "<opening line, max 12 words, punchy>",
      "caption": "<body of post, 100-140 words>",
      "cta": "<one clear call-to-action sentence>",
      "hashtags": ["#tag1","#tag2","#tag3","#tag4","#tag5","#tag6"]
    }
  ]
}`,
        }],
      }),
    });

    if (!claudeRes.ok) {
      const errText = await claudeRes.text();
      return new Response(
        JSON.stringify({ error: "AI generation failed", details: errText }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      );
    }

    const claudeData = await claudeRes.json();
    const rawText: string = claudeData.content[0].text;

    let theme = "GENERAL";
    let posts: any[];
    try {
      const cleaned = rawText.replace(/```json|```/g, "").trim();
      const parsed = JSON.parse(cleaned);
      theme = parsed.theme?.toUpperCase().trim() || "GENERAL";
      posts = parsed.posts;
      if (!Array.isArray(posts) || posts.length < 3) throw new Error("Bad format");
    } catch {
      return new Response(
        JSON.stringify({ error: "Could not parse AI output. Try again.", raw: rawText }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      );
    }

    // 3. Create ClickUp parent task — "SOCIAL POSTS [THEME]"
    const clickupToken = Netlify.env.get("CLICKUP_API_TOKEN");
    const parentTaskName = `SOCIAL POSTS ${theme}`;

    const parentRes = await fetch(`https://api.clickup.com/api/v2/list/${listId}/task`, {
      method: "POST",
      headers: { Authorization: clickupToken ?? "", "Content-Type": "application/json" },
      body: JSON.stringify({
        name: parentTaskName,
        description: `3 social media posts auto-generated from:\n${url}\n\nGenerated for: ${clientName}`,
        priority: 3,
      }),
    });

    if (!parentRes.ok) {
      const err = await parentRes.text();
      return new Response(
        JSON.stringify({ success: false, posts, clickupError: `Parent task creation failed: ${err}` }),
        { status: 207, headers: { "Content-Type": "application/json" } }
      );
    }

    const parentTask = await parentRes.json();

    // 4. Create 3 subtasks — POST 1, POST 2, POST 3
    // Caption goes into the TEXT custom field; full post also in description
    const createdSubtasks: Array<{ id: string; url: string; name: string }> = [];

    for (let i = 0; i < posts.length; i++) {
      const post = posts[i];
      const fullCaption = [post.hook, "", post.caption, "", post.cta, "", post.hashtags.join(" ")].join("\n");

      const subRes = await fetch(`https://api.clickup.com/api/v2/list/${listId}/task`, {
        method: "POST",
        headers: { Authorization: clickupToken ?? "", "Content-Type": "application/json" },
        body: JSON.stringify({
          name: `POST ${i + 1}`,
          description: fullCaption,
          parent: parentTask.id,
          priority: 3,
          custom_fields: [
            {
              id: TEXT_CUSTOM_FIELD_ID,
              value: fullCaption,
            },
          ],
        }),
      });

      if (subRes.ok) {
        const sub = await subRes.json();
        createdSubtasks.push({ id: sub.id, url: sub.url, name: sub.name });
      }
    }

    return new Response(
      JSON.stringify({
        success: true,
        theme,
        posts,
        parentTask: { id: parentTask.id, url: parentTask.url, name: parentTask.name },
        subtasks: createdSubtasks,
      }),
      { headers: { "Content-Type": "application/json" } }
    );
  } catch (err: any) {
    return new Response(
      JSON.stringify({ error: err.message ?? "Unknown server error" }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
};

export const config = { path: "/api/generate-posts" };
