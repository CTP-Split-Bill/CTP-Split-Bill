// POST /api/receipts/[id]/group-link -- Generate or rotate group token; return URL
// DELETE /api/receipts/[id]/group-link -- Revoke group token
import { currentUserId } from "@project/auth";
import { revalidatePath } from "next/cache";
import { issueGroupLink, revokeGroupLink, toApiError } from "@project/domain";

export const dynamic = "force-dynamic";
type Params = { params: Promise<{ id: string }> };

export async function POST(req: Request, { params }: Params) {
  try {
    const me = await currentUserId();
    const { id } = await params;
    const token = await issueGroupLink(me, id);
    revalidatePath(`/api/receipts/${id}`);
    return Response.json({ url: new URL(`/g/${token}`, req.url).toString() }, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (e) {
    return toApiError(e);
  }
}

export async function DELETE(_req: Request, { params }: Params) {
  try {
    const me = await currentUserId();
    const { id } = await params;
    await revokeGroupLink(me, id);
    revalidatePath(`/api/receipts/${id}`);
    return new Response(null, { status: 204 });
  } catch (e) {
    return toApiError(e);
  }
}


