---
status: testing
phase: 04-history-writes-persistence-loop
source: 04-01-SUMMARY.md
started: 2026-03-10T18:00:00Z
updated: 2026-03-10T18:00:00Z
---

## Current Test
<!-- OVERWRITE each test - shows where we are -->

number: 1
name: Commenter History Written After Reply
expected: |
  Send a comment on a business's Instagram post that has auto-reply enabled. After the auto-reply is posted, check Firestore at `businesses/{businessId}/commenters/{igUserId}`. A document should exist with: `comment_count: 1`, `last_seen_at` (recent timestamp), `first_seen_at` (same as last_seen_at for first comment), `username` (commenter's IG username), `last_comment_text` (the comment text), and `expires_at` (~90 days from now).
awaiting: user response

## Tests

### 1. Commenter History Written After Reply
expected: Send a comment on a business's Instagram post that has auto-reply enabled. After the auto-reply is posted, check Firestore at `businesses/{businessId}/commenters/{igUserId}`. A document should exist with `comment_count: 1`, `last_seen_at`, `first_seen_at`, `username`, `last_comment_text`, and `expires_at` (~90 days from now).
result: [pending]

### 2. Commenter History Increments on Repeat Comment
expected: Send a second comment from the same Instagram account on any post of the same business. Check Firestore — the commenter doc should now show `comment_count: 2`, `last_seen_at` updated to the newer timestamp, `first_seen_at` unchanged from test 1, and `last_comment_text` updated to the new comment.
result: [pending]

### 3. Post Reply Log Written and Capped
expected: After the auto-reply is posted, check Firestore at `businesses/{businessId}/instagram_post_replies/{mediaId}`. A document should exist with `recent_replies` array containing `{ text, at }` objects for the replies on that post, capped at 8 entries max, and `expires_at` (~30 days from now).
result: [pending]

### 4. Fire-and-Forget — No Webhook Delay
expected: Check the Cloud Run logs for the webhook handler. The `replied to comment` log should appear immediately after the Instagram API reply call. History write warnings (if any) should appear AFTER the reply log, confirming writes don't block the response. No `History write failed` warnings should appear under normal conditions.
result: [pending]

### 5. Both AI and Static Replies Trigger Writes
expected: Send a comment on a post with a static template reply configured (not AI mode). After the template reply is posted, verify the commenter doc and post reply log are still written to Firestore — writes should happen for both AI and static reply modes, not just AI.
result: [pending]

### 6. Anonymous Comments Skip Writes
expected: If a comment arrives without a `from.id` (anonymous/system comment), verify no Firestore writes are attempted. Check Cloud Run logs — no `History write failed` or write-related log entries should appear for that comment.
result: [pending]

## Summary

total: 6
passed: 0
issues: 0
pending: 6
skipped: 0

## Gaps

[none yet]
