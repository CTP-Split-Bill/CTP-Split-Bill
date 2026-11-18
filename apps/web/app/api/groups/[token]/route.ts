// GET /api/groups/[token] -- Return receipt overview and claim status
import { getGroup, toApiError } from "@project/domain";
import { withGuestHeaders } from "../../picks/[token]/headers";

export const dynamic = "force-dynamic";
type Params = { params: Promise<{ token: string }> };

export async function GET(_req: Request, { params }: Params) {
  try {
    const { token } = await params;
    return withGuestHeaders(Response.json(await getGroup(token)));
  } catch (e) {
    return withGuestHeaders(toApiError(e));
  }
}
