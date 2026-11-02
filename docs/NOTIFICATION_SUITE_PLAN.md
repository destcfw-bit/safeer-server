# Notification Suite — implementation plan (32 features)

Status: SPECIFICATION ONLY — not deployed or implemented.

## Safety invariants
- Never change accounting balances, commissions, withdrawals, or WhatsApp order processing from notification code.
- Push sending is asynchronous and best-effort; never block an inventory transaction.
- Require role-based authorization, opt-in permissions, deduplication and rate limits.
- Never expose subscription endpoints or VAPID private keys in logs.
- A push-provider acceptance is not proof of delivery or reading.

## Captain alerts (1–10)
1. Custom foreground sound with user gesture unlock and mute.
2. Production details with counterparty and earned amount.
3. Consumption details with counterparty and deducted amount.
4. Cancellation alerts to both affected parties.
5. Adjustment alerts with old and new amounts.
6. Low balance threshold alerts.
7. Balance top-up alerts.
8. Withdrawal approval alerts.
9. Withdrawal rejection with reason.
10. Weekly floor fee alert.

## User experience (11–18)
11. Persistent in-app notification inbox.
12. Unread badge.
13. Deep links to authorized details.
14. Digest for noncritical alerts.
15. Per-type preferences for optional alerts.
16. Event-id based idempotent deduplication.
17. Subscription refresh and stale endpoint cleanup.
18. Read/unread retention for important messages.

## Admin tools (19–26)
19. Push failure alerts.
20. Accepted/rejected/device counts dashboard.
21. Unsubscribed captains report.
22. Individual/selected/all composer.
23. Scheduled campaigns.
24. In-app emergency banner.
25. Audit log of actor, time, counts, error codes.
26. Bounded retry for transient failures, no duplicate messages.

## Smart alerts (27–32)
27. Weekly accounting digest.
28. Thursday/Friday withdrawal reminders for eligible captains.
29. Withdrawal-window closing reminder.
30. Inactivity reminder with opt-out and cooldown.
31. Admin anomaly alert for suspicious adjustments/duplicates.
32. Transfer confirmation alert.

## Verification checklist
- Audit Captain.html, service worker registration and push event handler, server.js routes, DB migrations, VAPID config, and Coolify runtime logs.
- Test Android and iOS installed PWA, foreground/background, locked screen, permissions denied, offline recovery.
- Confirm notification sound constraints: custom sound only in active foreground context after user interaction; background uses OS sound settings.
- Test all roles and ensure no unauthorized access or disclosure.
- Use staging/test captains before production; never send mass tests without confirmation.
