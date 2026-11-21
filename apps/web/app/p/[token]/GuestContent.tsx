import { ApiError, getPicks } from "@project/domain";
import { GuestPicker } from "./GuestPicker";
import { SplitSummary } from "./SplitSummary";
import { INVALID_LINK, toGuestView } from "./guest-view";
import GuestError from "./error";

export async function GuestContent({ token }: { token: string }) {
  let data;
  try {
    data = await getPicks(token);
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) {
      return <h1 className="text-2xl font-semibold">{INVALID_LINK}</h1>;
    }
    // Do not log database errors or send them to Next's error logger: a query
    // error can contain the token hash. The retry only gets generic props.
    return <GuestError />;
  }
  const receipt = toGuestView(data);
  return receipt.finalized ? <SplitSummary receipt={receipt} /> : <GuestPicker key={token} token={token} initial={receipt} />;
}
