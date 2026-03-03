import { NextRequest } from "next/server";
import { spawn } from "child_process";

export const dynamic = "force-dynamic";
export const maxDuration = 300; // 5 minutes for long installs

/**
 * POST /api/skills/install
 *
 * Streams live terminal output from an install command (brew, npm, etc).
 * Returns Server-Sent Events with { type, text } payloads.
 *
 * Body: { kind: "brew" | "npm", package: string }
 */
export async function POST(request: NextRequest) {
  const body = await request.json();
  const kind = body.kind as string;
  const pkg = body.package as string;

  if (!pkg) {
    return new Response(
      JSON.stringify({ error: "package required" }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }

  // Basic package name validation: allow alphanumeric, @, /, ., -, _
  // This covers npm scoped packages (@scope/pkg), pip, and brew package names.
  // Disallow sequences that could enable path traversal (..) or ambiguous paths (//).
  if (!/^[a-zA-Z0-9@][a-zA-Z0-9@/._-]*$/.test(pkg) || pkg.includes("..") || pkg.includes("//")) {
    return new Response(
      JSON.stringify({ error: "invalid package name" }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }

  // Build command based on kind
  let cmd: string;
  let args: string[];

  switch (kind) {
    case "brew":
      cmd = "brew";
      args = ["install", "--verbose", pkg];
      break;
    case "npm":
      cmd = "npm";
      args = ["install", "-g", pkg];
      break;
    case "pip":
      cmd = "pip3";
      args = ["install", pkg];
      break;
    default:
      return new Response(
        JSON.stringify({ error: `Unsupported install kind: ${kind}` }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
  }

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    start(controller) {
      // Send initial banner
      const banner = `\x1b[1;36m$ ${cmd} ${args.join(" ")}\x1b[0m\n`;
      controller.enqueue(
        encoder.encode(`data: ${JSON.stringify({ type: "stdout", text: banner })}\n\n`)
      );

      const child = spawn(cmd, args, {
        env: { ...process.env, NO_COLOR: "0", HOMEBREW_COLOR: "1" },
        timeout: 240000,
        stdio: ["pipe", "pipe", "pipe"],
      });

      child.stdout.on("data", (data: Buffer) => {
        const text = data.toString();
        try {
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify({ type: "stdout", text })}\n\n`)
          );
        } catch { /* stream closed */ }
      });

      child.stderr.on("data", (data: Buffer) => {
        const text = data.toString();
        try {
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify({ type: "stderr", text })}\n\n`)
          );
        } catch { /* stream closed */ }
      });

      child.on("close", (code) => {
        try {
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({ type: "exit", code: code ?? 1 })}\n\n`
            )
          );
          controller.close();
        } catch { /* stream closed */ }
      });

      child.on("error", (err) => {
        try {
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({ type: "error", text: String(err) })}\n\n`
            )
          );
          controller.close();
        } catch { /* stream closed */ }
      });

      // Close stdin immediately
      child.stdin.end();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
