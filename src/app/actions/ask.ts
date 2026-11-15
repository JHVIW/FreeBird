"use server";
import { run, fstr } from "@/lib/action";
import { ask } from "@/lib/ai-ask";

export async function askAction(fd: FormData) {
  await run("/vraag", async () => { await ask(fstr(fd, "question")); });
}
