// POST /api/groups/[token]/claim -- Claim participant and issue personal link
import { apiError, ClaimGroupParticipant, claimGroupParticipant, invalidInput, toApiError } from "@project/domain";
import { withGuestHeaders } from "../../../picks/[token]/headers";

export const dynamic = "force-dynamic";
type Params = { params: Promise<{ token: string }> };

export async function POST(req: Request, { params }: Params) {
  try {
    const { token } = await params;
    const body = await req.json().catch(() => null);
    if (body === null) return withGuestHeaders(apiError("INVALID_INPUT", "Body must be valid JSON", 400));
    const parsed = ClaimGroupParticipant.safeParse(body);
    if (!parsed.success) return withGuestHeaders(invalidInput(parsed.error));
    const personalToken = await claimGroupParticipant(token, parsed.data);
    return withGuestHeaders(Response.json({ url: new URL(`/p/${personalToken}`, req.url).toString() }));
  } catch (e) {
    return withGuestHeaders(toApiError(e));
  }
}
