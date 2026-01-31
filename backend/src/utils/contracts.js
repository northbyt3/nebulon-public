const CONTRACT_STATUSES = [
  "pending_invite",
  "invite_expired",
  "invite_canceled",
  "waiting_for_init",
  "negotiating",
  "awaiting_signatures",
  "waiting_for_funding",
  "waiting_for_milestones_report",
  "in_progress",
  "ready_to_claim",
  "completed",
  "disputed",
  "canceled"
];

const INVITE_STATUSES = ["pending", "accepted", "canceled", "expired"];

module.exports = {
  CONTRACT_STATUSES,
  INVITE_STATUSES,
};
