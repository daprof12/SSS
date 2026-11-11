# ERP — UX gap analysis and pre-build update list

Reviewed 2026-10-17: all 13 spec docs in `document/`, the canvas bundle (`ERP App and Dashboard Design.html`, 49 boards) and the full export in `ERP App and Dashboard Design/` (148 boards — the current source of truth; the HTML is an older subset).

**Bottom line:** the happy paths are well covered, but 6 areas block a build: (1) spec conflicts, (2) profile/account pages for every non-citizen role, (3) ~30 flows referenced by buttons that lead nowhere, (4) the modal inventory, (5) motion is specified only for the SOS button, (6) light mode exists for 1 of 148 screens. Security is well specified in docs but several controls have no screen.

---

## 1. Resolve these spec conflicts first

| # | Conflict | Where | Recommendation |
|---|---|---|---|
| C1 | Officer bottom bar: "Dispatch, Map, SOS‑assist, Log, Profile" vs "Home, History, Report, Wallet, Profile" | Design Brief vs Rewards doc (canvas follows Rewards) | Keep the canvas bar, but add an **officer panic / "Officer needs help"** action (see O‑1). Update the Design Brief. |
| C2 | Two "States and Notifications" docs with different wording, tabs and rules | `States and Notifications.docx` vs `(1).docx` | Merge into one. Keep `(1)` (it has the global state rules + notification catalogue); fold in the officer/station tables from the other. |
| C3 | OTP: 6 digits / 5 min / 3 tries vs 10 min / 5 tries | the two States docs | Pick one: **5 min, 5 tries, 60 s resend cooldown**. |
| C4 | Cancel window: 5 s ring vs "Cancel within [30] seconds: no fine" | Brief/SRS vs States (1) | 5 s pre‑send ring **plus** a 30 s free post‑send cancel. Document both. |
| C5 | Activity tabs: "All, Open, Resolved, Fines" vs "All, Open, Closed, Fines"; Notification tabs differ too | the two States docs | Pick one set; canvas must match. |
| C6 | Sign‑in: SRS says phone OTP first; canvas "Log in" is email + password first | SRS AUTH‑1 vs Log in board | Make phone OTP the primary path; password secondary. Many users won't remember a password under stress. |
| C7 | Citizen tab label "Me" vs "Profile" (officer uses "Profile") | Home vs officer boards | Use "Profile" everywhere. |
| C8 | Officer "Decline reason": always required vs "required after [3] declines in a shift" | States vs States (1) | Always required (a one‑tap chip, so it costs nothing). |
| C9 | No owner for the **technician / installer** role: admin has "Installation team" + "Install job" (customer confirmation code) but no technician surface | PRD roles table lists 6 roles | **Decided:** a 7th role, `technician`, with its own mobile surface (see T‑1). Add it to `user_roles`. |

---

## 2. Profile and account pages — per role

### 2.1 Citizen / household owner (`Profile and trust (dark)`) — missing rows

The current profile has: My home and devices, Subscription, Fines and appeals, Theme, Bank account, Language, Discreet mode. Proposed order (grouped, each row → its own screen):

| Group | Row | Status | Notes |
|---|---|---|---|
| Header | Avatar, name, verified badge, **Edit profile** | Edit missing | Name/phone/email change needs step‑up PIN + OTP on the new value. |
| Header | Trust score card → **Trust detail** | Detail missing | History of changes, reason, "how to improve". |
| Money | **Wallet** [Balance] | ❌ missing (screen exists, no entry) | Opens `Wallet (dark)`. |
| Money | **Donations** — "Support responders" + my donation history & receipts | ❌ missing | Opens `Donate (dark)` with a History tab. |
| Money | **My tips and bounties** [n] | ❌ missing (officer has it) | List screen not drawn; `Tip detail` exists. |
| Money | Bank account for withdrawals | ✅ | Move under Wallet; keep row. |
| Money | Payments and receipts | ❌ missing | PAY‑3 — invoices, fines paid, donations, install fee. |
| Home | My home and devices | ✅ | |
| Home | **Household members** | ❌ no list screen | `Household invite` exists; add list, roles, remove. |
| Home | Subscription | ✅ | |
| Safety | **Security** | ❌ missing (screen exists, no entry) | Opens `Profile security 2FA, PIN, face`. |
| Safety | **Emergency contacts** | ❌ not in any spec | Recommend: up to 3 people auto‑notified with a live‑status link when you send SOS. Strong safety value. |
| Safety | **Saved places** (home, work, parents) | ❌ | REP‑3 "saved building". |
| Safety | Discreet mode | Row ✅, screen ❌ | Neutral icon/name picker, quick‑exit gesture, test it. |
| Safety | Fines and appeals | ✅ | |
| App | Appearance (rename from "Theme") | ✅ | Opens `Appearance` board. |
| App | Language | Row ✅, picker ❌ | |
| App | **Notifications** preferences | ❌ | Per group on/off; safety/security/payment locked on; quiet hours. |
| App | **Permissions** (location, camera, mic, notifications) | ❌ | Status + "open phone settings". |
| Help | **Help and support**, Replay feature tour (AUTH‑2), Terms, Privacy | ❌ | |
| Data | **My data (NDPA)**: download my data, correction request, delete account | ❌ | Required by Security doc (access/correction/deletion rights). |
| — | **Sign out** | ❌ (officer has it) | |

### 2.2 Officer (`Officer profile and rating`) — missing rows

Has: rating, team, wallet, rewards, bank, tips, theme, sign out. Add:

- **Security** (2FA is *required* for officers — currently unreachable).
- **Documents and badge**: badge number, rank, expiry, renewal upload ("Badge expiring" notification has no destination). States doc lists Profile tabs "Rating, Team, Documents, Settings" — Documents and Settings aren't drawn.
- **Duty and shifts**: my roster, request swap/leave (station roster has swap/leave requests but officer can't create them).
- **Notifications** (dispatch sound, vibration pattern, repeat — cannot turn dispatch off).
- **Language**, **Appearance** (rename Theme), **Permissions** (location "Always" is critical for offers).
- **Edit profile/photo** (photo is shown to citizens on the officer card — needs a moderation/approval step).
- **Help**, **Sign out** with "You have an active incident" guard.

### 2.3 Station head / dispatcher, agency admin, platform admin — no personal profile at all

All three dashboards have organisation **Settings** only. Components doc specifies a **top bar with search, theme toggle and user menu** — none of the dashboard boards draw a top bar. Add:

1. **Top bar** on every dashboard page: global search, notification bell + panel, theme toggle (System/Light/Dark), user avatar menu.
2. **User menu** → My profile · Security · Notifications · Appearance · Help · Sign out.
3. **My profile page (shared across all three dashboards)**:
   - Personal: name, photo, role(s) + scope ("Dispatcher, Station 4"), phone, email (change with step‑up).
   - Security: 2FA (mandatory, cannot disable), passkey/authenticator, active sessions with IP/location/device, revoke, recovery codes, sign‑in history.
   - Notifications: per alert, per channel.
   - Preferences: language, time format, default landing page, density.
   - "My activity" — the user's own audit entries (transparency for staff who open camera views).
4. **Role switcher** — a station head who is also an officer, or an agency admin with several agencies, needs to switch scope without signing out.
5. Station sidebar: **Station profile** (public face — name, photo, rating, donations received) is distinct from Settings; citizens donate to it and see it.

---

## 3. Missing process flows (button exists, destination doesn't)

Legend: **M** = must for MVP per SRS priorities.

### Citizen / household
| ID | Flow | Trigger on canvas | Pri |
|---|---|---|---|
| CZ‑1 | **Cancel a live report** with reason (REP‑7), incl. "flagged not blocked" after dispatch | Live status has no cancel | M |
| CZ‑2 | **Report sending failed / offline → SMS fallback** (REP‑8) and queued state | none | M |
| CZ‑3 | **SOS without account / unverified** limited path (AUTH‑4) | none | S |
| CZ‑4 | **Permission priming** screens (location, notifications, camera, mic) + "denied → open settings" | Wireframe list | M |
| CZ‑5 | **Add info** sheet: voice note, photo, one line, upload progress, failure retry | button on Live status | S |
| CZ‑6 | **Message responder** chat (and masked call) | button on Live status | M |
| CZ‑7 | Status variants: **Waiting (no one yet)**, **Escalating to next station**, **Officer cancelled, reassigning**, **Transferred**, **On scene**, **Resolved → rate** | Only "En route" drawn | M |
| CZ‑8 | **Post‑resolution after‑care**: rating ✅ → safety tips → optional donate → thank you | rating exists; chain not drawn | M |
| CZ‑9 | **Discreet mode** set‑up + quiet report UI + quick exit (REP‑9) | row only | S |
| CZ‑10 | **Domestic violence / homicide** discreet report with rights guidance | PRD | S |
| CZ‑11 | **Fund wallet** (amount → Paystack → success/fail) and **Add/verify bank account** (name match) | buttons on Wallet | M |
| CZ‑12 | **Subscribe**: plan → install fee + first month → **book install visit** → confirmation code at install → devices live | single subscription board | M |
| CZ‑13 | Plan **change / pause / cancel** + Paystack card update | PAY‑2 | M |
| CZ‑14 | **Receipts and invoices** list + receipt detail/PDF | PAY‑3 | M |
| CZ‑15 | **My tips** list (Sent/Paid/Declined), anonymous toggle explanation | tip detail exists | S |
| CZ‑16 | **Household members** list, member permissions, leave household, community‑lead variant | invite exists | S |
| CZ‑17 | **Edit/confirm location** before confirm (REP‑3) and "postcode service down" fallback | "Edit" on home | M |
| CZ‑18 | **Statement request** arrival (notification → record) and "officer requested a change → sign v2" | statement boards exist | S |
| CZ‑19 | **Account recovery**: lost phone, new device binding, "Not you? Lock account" from security alert | Security doc | M |
| CZ‑20 | **Public issue** follow‑through: my issues list, status, "confirm it's fixed" | category + road form only | S |

### Officer
| ID | Flow | Pri |
|---|---|---|
| O‑1 | **Officer panic / "I need help now"** — one‑hold button visible on any active incident; broadcasts location to station + nearby units. Safety‑critical, not in any spec. | M |
| O‑2 | **Duty toggle** go on/off duty, with location check and "active incident — hand over first" block | M |
| O‑3 | **Navigate** (deep link to maps + in‑app route) and **status stepper** Accepted → En route → On scene → Resolved | M |
| O‑4 | **Request reinforcement** / **Transfer** sheet (reason, agency, station; approval when non‑emergency) | M |
| O‑5 | **Close incident**: outcome code, valid / unfounded / malicious + evidence (TRUST‑2, DISP‑6) | M |
| O‑6 | **Clips viewer** in brief with "access logged" banner and expiry (BRIEF‑3/5) | S |
| O‑7 | **Drone request** (C) | C |
| O‑8 | **Officer onboarding**: accept invite (link/OTP) → KYC → badge upload → pending ID → approved | M |
| O‑9 | **Request statement** from reporter | S |
| O‑10 | **Notification centre** (All, Dispatch, Team, Money) | M |
| O‑11 | **Offer taken by another unit** state (offer expired is drawn) | M |

### Station head / dispatcher
| ID | Flow | Pri |
|---|---|---|
| S‑1 | **Assign unit**, **Reinforce**, **Transfer**, **Close report** modals (buttons drawn, modals not) | M |
| S‑2 | **Escalation** handling: "no one accepted in [n] s" banner → actions | M |
| S‑3 | **Invite officer** (station officers page) + resend/revoke invite | M |
| S‑4 | **Roster edit**: add shift, swap/leave approval, overlap error, gap warning | M |
| S‑5 | **Sign off monthly report** + export PDF (App Flow) | S |
| S‑6 | **Message an officer / broadcast** to on‑duty officers | S |
| S‑7 | **Statement change request** to reporter | S |
| S‑8 | **Live queue** row arrival, priority raise, "taken" — realtime states | M |

### Agency admin
| ID | Flow | Pri |
|---|---|---|
| A‑1 | **Add station** → assign head → set area → go live checklist | M |
| A‑2 | **Fund bounty pool** (Paystack) and pool‑low banner | S |
| A‑3 | **Link payout bank / Paystack subaccount** with verification | M |
| A‑4 | **Change role / remove team member** confirmation | M |
| A‑5 | **Approve/decline bounty** confirm (claim detail exists) | S |
| A‑6 | **Agency analytics/reports** (ADM‑4 — only Overview drawn) | M |
| A‑7 | **Agency billing**: pay invoice, overdue lock‑out banner | M |
| A‑8 | **Re‑approval** when name/type changes (pending state) | S |

### Platform admin
| ID | Flow | Pri |
|---|---|---|
| P‑1 | **Public issues** and **Assets** admin pages (doc says "not yet done") | S |
| P‑2 | **Bounty and wallet oversight** (Pools, Claims, Disputes, Ledger, reconciliation mismatch) — in States doc, no board | S |
| P‑3 | **System health** page (dispatch latency, provider status, queue depth) — App Flow | M |
| P‑4 | **Merge rules** settings (radius, window, auto‑merge pairs) | S |
| P‑5 | **Second‑approver** flows: large CRM send, payout, fee change | M |
| P‑6 | **Block / suspend user** with reason; **unblock** | M |
| P‑7 | **Staff invite** and role assignment (Staff roles card has no add) | M |
| P‑8 | **Data subject requests** queue (NDPA access/delete) | M |

### Technician / installer
| ID | Flow | Pri |
|---|---|---|
| T‑1 | Mobile job list → job detail → site checklist → scan serials → customer confirmation code → device reports online → close. Also repair tickets from citizen "Report a problem". | M (Phase 3) |

---

## 4. Modal and confirmation inventory

Rule (States doc): money out, deletes, switching off devices, declining a bounty, removing an officer need a confirm whose button names the action.

| Modal / sheet | Role | Drawn? |
|---|---|---|
| Camera live‑view reason gate | Admin | ✅ |
| Merge reports | Station | ✅ |
| Decline offer reason | Officer | ✅ |
| Confirm PIN (step‑up) | All | ✅ (needs biometric variant + locked variant reuse) |
| Withdraw confirm "Withdraw [Amount] to [Bank] ending [0000]?" | Citizen, officer | ⚠️ validation drawn, confirm sheet not |
| Cancel report (reason chips) | Citizen | ❌ |
| Low‑trust "Is this a real emergency?" (non‑blocking) | Citizen | ❌ |
| Remove household member | Owner | ❌ |
| Cancel / pause subscription | Owner | ❌ |
| Payment sheet: Paystack handoff, success, failure, retry | All payers | ⚠️ partial |
| Donation success + receipt | Citizen | ❌ |
| Street‑light boost confirm ("[n] uses left tonight") | Owner | ❌ |
| Go off duty with active incident (blocking) | Officer | ❌ |
| Reinforce / transfer / assign unit / close report | Officer, station | ❌ |
| Split merged incident | Station | ❌ |
| Remove officer / revoke invite | Station, agency | ❌ |
| Change role | Agency, admin | ❌ |
| Approve / decline bounty (amount + tipper no.) | Agency | ⚠️ claim detail only |
| Approve agency, waive / reduce / uphold fine, reject KYC (reason) | Admin | ⚠️ cards, no confirm |
| Block user (reason) | Admin | ❌ |
| Revoke session / sign out all devices | All | ❌ |
| Disable 2FA (blocked for staff) / regenerate recovery codes | All | ❌ |
| Delete account (type to confirm, wallet balance must be zero, open fines) | Citizen | ❌ |
| Session expiring / signed out for inactivity | Dashboards | ❌ (`Signed out` exists for mobile) |
| Discard unsaved changes (Settings pages with "Save changes") | Dashboards | ❌ |

**Modal behaviour spec to add:** bottom sheet on mobile, centred dialog ≥ 768 px; focus trapped; Esc/back closes non‑destructive only; destructive primary uses Emergency colour; never stack more than one modal (use a step inside the sheet); no modal may ever cover the SOS button or an active offer countdown.

---

## 5. Motion, micro‑interactions and transitions

The Design Brief defines only: 200 ms ease‑out, SOS pulse, 5 s ring, two haptics, reduced‑motion. Add a motion token set and per‑component rules.

### Tokens
| Token | Value | Use |
|---|---|---|
| `motion.instant` | 100 ms | press states, toggles, checkbox |
| `motion.fast` | 200 ms ease‑out | default UI, chips, tabs |
| `motion.sheet` | 280 ms, enter `cubic-bezier(.2,.8,.2,1)`, exit 200 ms ease‑in | sheets, dialogs, page push |
| `motion.emphasis` | 400 ms spring (damping ~0.8) | success, status step complete |
| `motion.ambient` | 2 s loop | SOS pulse, live dot only |

### Per component
| Element | Behaviour |
|---|---|
| Page navigation | Mobile push: slide 24 px + fade; tab switch: cross‑fade only (no slide). Dashboards: no page transitions; panels fade 150 ms. |
| SOS | Rest pulse (disabled in incident mode & reduced motion); press scale 0.96; ring countdown 5 s linear with per‑second haptic tick; cancel = ring reverses 200 ms. |
| Status timeline | Step fills over 400 ms, dot pops; success haptic on "Accepted"; ETA number rolls, never jumps. |
| Map | Unit marker interpolates between GPS points (no teleport); route draws once; camera pans ease 600 ms; no auto‑zoom while the user is touching the map. |
| Officer offer | Full‑screen enter from bottom, countdown ring, repeating vibration pattern, ring turns Warning at 10 s, Emergency at 5 s. |
| Lists / queues | New row slides in from top with 1 s Signal highlight fade; removed row collapses 200 ms. Never reorder under the cursor — show "[n] new" pill instead. |
| Skeletons | Shimmer 1.2 s; after 8 s swap to "Still loading" (rule exists). |
| Toast | Slide up 12 px + fade, 3 s, swipe to dismiss; one at a time, queue rest. |
| Forms | Error text fades in 150 ms; PIN/OTP wrong → horizontal shake 300 ms + error haptic; OTP auto‑advance between boxes. |
| Money | Balance count‑up 600 ms after fund/withdraw; success check draws 400 ms. No confetti (calm product). |
| Learn feed | Vertical snap paging, 300 ms; like = heart scale 1.2 → 1. |
| Theme switch | 200 ms colour cross‑fade on tokens, not a page flash. |
| **Incident mode** | While a report is live: no ambient motion except the live dot and the moving unit marker. |
| **Reduced motion** | All transforms → opacity fades ≤ 150 ms; pulses off; map pans become jumps; haptics kept. |

---

## 6. Light mode

- **Drawn:** `Home (light)` and the preview card inside `Appearance`. **Not drawn:** 146 boards (all mobile dark; every dashboard dark). The Public Issues doc confirms "Light versions of most screens are not drawn yet".
- **Token gaps** in the Design Brief: no light values for *surface sunken / input*, *overlay scrim*, *focus ring*, *chart palette*, *map style*, *disabled*, *status chip backgrounds* (tinted fills like the green "Verified" pill), *skeleton*, *shadow scale* ("#FFFFFF with shadow" is not a token).
- **Specific checks:** Emergency light `#E11D48` on white passes AA for text; Warning `#B45309` passes; Signal `#0891B2` (3.68:1) and Success `#059669` (3.77:1) on white **fail AA for small text** (contrary to the Brief's "meets AA in both" claim) — use `#0E7490` (5.36:1) and a darker green such as `#047857` for text, keeping the current values for fills and icons. Officer rating yellow on white needs the darker Warning token.
- **Maps:** need a light map style and the "Dim map at night" rule defined for light mode.
- **Plan:** (1) add the missing tokens; (2) redraw the 10 most‑used screens in light first — Home ✅, Confirm, Live status, Activity, Profile, Wallet, Officer home, Officer offer, Station live incidents, Admin overview; (3) the rest can be generated from tokens once components are tokenised; (4) add a dashboard theme toggle in the top bar.

---

## 7. Security — specified but not yet designed

| Control (from Security / Public Issues docs) | Gap |
|---|---|
| 2FA set‑up: authenticator QR, verify code, recovery codes shown once, SMS backup | Only the settings row exists. Need the set‑up wizard and **forced enrolment at first staff sign‑in**. |
| Step‑up for profile changes (phone, email, bank) | No change‑phone / change‑email flows. |
| Trusted devices / active sessions | "Manage" leads nowhere; need list + revoke + "sign out everywhere". |
| New sign‑in alert → "Lock my account" | No lock / recovery flow. |
| Device binding | No "new device — verify with OTP + PIN" screen. |
| PIN | Create/confirm/locked ✅; **change PIN** and **forgot PIN via KYC selfie** need flows (Forgot PIN board exists — check it links to re‑verification). |
| Withdrawals: fresh sign‑in, daily limit, delay on first | Need "first withdrawal held [n] h" state. |
| Officer phone lost | Remote sign‑out by station head; app wipes cached briefs/clips. |
| Screen protection | Mark camera view, clips, statements, KYC, recovery codes as **no‑screenshot / blurred in app switcher**. |
| PII masking on dashboards | Reporter phone/name masked by default; "Reveal" logs reason (same pattern as camera gate). Anonymous tipper identity: never revealable to agency. |
| Clip watermark | Viewer's name + time over clips (Security doc) — not on the clip player. |
| Idle timeout | Dashboards: lock after [15] min idle; officer app: biometric re‑lock on resume. |
| Rooted / jailbroken device | Warning screen; block wallet & statement signing, never block SOS. |
| Invite links | Expiry, single use, bound to phone; "invite expired" state. |
| Discreet mode | Quick exit must not leave the report UI in recents. |

---

## 8. Recommended order before code

1. Settle conflicts C1–C9 and merge the two States docs.
2. Add tokens (light, motion, overlay, focus) to the Design Brief and Components doc.
3. Design: dashboard top bar + shared **My profile**; citizen and officer profile rows; security set‑up wizard.
4. Design the **M** flows in §3 (CZ‑1, 2, 4, 6, 7, 8, 11–14, 17, 19; O‑1–5, 8, 10, 11; S‑1–4, 8; A‑1, 3, 4, 6, 7; P‑3, 5–8).
5. Build the modal inventory (§4) as one component sheet.
6. Light mode for the top 10 screens, then the rest.
7. Remaining S/C flows and the technician surface.

## Build readiness gate (2026-10-17)

**Result: not all requirements are satisfied.** The product requirements are complete enough to start foundation code. They are not complete enough to build screens to the canvas or to launch.

| Area | State | Blocks |
|---|---|---|
| Product scope, roles, state machines, data flow | ✅ Specified (PRD, SRS, these two docs) | — |
| Spec conflicts C1–C9 | ⚠️ Recommendations written, not approved by you | Screen code that depends on them |
| Missing screens (~30 flows, 7 profile/settings sets, all modals) | ❌ Specified in text, not drawn | Pixel‑accurate UI; code can follow the text specs instead |
| Light mode (146 of 148 boards) and tokens | ❌ Tokens incomplete; 2 light colours fail AA | Theming code until tokens are fixed |
| Two choices to confirm: billing starts at install; emergency contacts see area only | ⚠️ Awaiting you | Billing and contacts modules |
| Postcode API endpoints, KYC provider, SMS/WhatsApp providers | ❌ External | Real integrations — mock adapters can stand in |
| Prices, fees, day counts, limits | ❌ Placeholders | Nothing — held as config |
| Paystack | ⚠️ Test mode only | Live money |
| Legal: NDPA DPIA, wallet licence or partner bank, fines' legal basis, paying informants, drones, evidence admissibility | ❌ Open | **Launch.** The wallet licence answer may change the wallet design itself. |
| Pilot agency and zone, CAD integration | ❌ Open | Pilot, not code |
| Codebase and tooling | ❌ No repo exists; Flutter not installed on this Mac | Mobile apps |

**Can start now without waiting:** the monorepo; the NestJS API; the PostgreSQL/PostGIS schema with the full incident and report state machines; the role‑filtered incident views; the append‑only ledger and audit log; mock adapters for postcode, KYC, Paystack and SMS; the design‑token package (dark, light with corrected colours, motion); the Next.js dashboard shell with top bar and My profile.

**Must wait:** final mobile and dashboard screens (until drawn or the text specs are approved as the source), live payments, real KYC and postcode, and anything legal.

## Decisions (2026-10-17)
- **Emergency contacts** and **officer panic button (O‑1)**: in MVP.
- **Technician**: its own role and surface (confirmed).
- **Report tracking and data flow between users**: specified in [Report Tracking and Data Flow.md](Report%20Tracking%20and%20Data%20Flow.md).
- **Delete account**: blocked until settled — wallet balance must be ₦0 (withdraw first), no open or appealed fines, no pending withdrawal, no active subscription. The delete screen lists each blocker with a button to resolve it.

---

## 9. Fund wallet — process flow

**What exists:** `Wallet (dark)` and `Officer wallet (dark)` each have a Fund button. **Nothing behind it** — no amount screen, method choice, Paystack handoff, pending, success or failure state.

**Other wallet gaps found**
- Citizen wallet has **no tabs**; States doc requires All / Rewards / Bounties / Payments / Withdrawals (officer wallet has them).
- Withdraw says "You will confirm with a **code**"; Public Issues doc says withdrawals use the **6‑digit PIN** (+ biometric). Pick PIN, with OTP only as step‑up on the first withdrawal or a new bank account.
- **Officer "Fund"** has no stated purpose — officers pay nothing. Remove it, or define the use (paying a personal fine, donating).
- No **auto‑pay from wallet** toggle, although billing rules rely on it.
- No **pending / held** breakdown ("[Amount] pending" has no detail).

**Entry points:** Wallet → Fund · Payment problem → Pay from wallet (insufficient) → "Top up [shortfall]" · Donate / Pay fine with wallet selected and too little balance → same shortcut, pre‑filled with the shortfall.

| Step | Screen / state | Rules |
|---|---|---|
| 0 | **Gate** | KYC verified required (wallet licence). Unverified → "Verify to use your wallet" → KYC. Wallet frozen → explain + support. |
| 1 | **Amount** sheet | Numeric keypad, chips [₦1k, 5k, 10k, Other]; min [Amount]; max per transaction and per KYC tier; show fee line and "You'll receive [Amount]" (decide who pays the Paystack fee). Live validation per States doc. |
| 2 | **Method** | Saved card (last 4) · New card · **Bank transfer to your personal account number** (Paystack Dedicated Virtual Account — the most used method in Nigeria) · USSD. Show the last used method first. |
| 3a | Card / USSD → **Paystack checkout** | Hosted checkout in webview; closing it = "Payment not finished" with Try again. Saved card charge needs PIN/biometric. |
| 3b | Bank transfer → **Account details** | Bank name, account number, name, copy buttons, "Transfers usually arrive in minutes". No time limit for a DVA. |
| 4 | **Confirming** | Spinner + reference. Credit only on the signed webhook, never on the client callback. Poll ≤ 30 s, then "Still confirming — we'll notify you" and show a Pending row in activity. |
| 5 | **Success** | Check animation, balance count‑up, receipt (reference, method, time), toast. Offer once: "Turn on auto‑pay for your subscription?" if they subscribe. |
| 5 | **Failed** | Paystack reason in plain words, "You were not charged", Try again / Other method. |
| 5 | **Pending too long** (> [n] min) | "Contact support" with the reference prefilled. |

**Edge cases to design:** idempotency key per attempt (double‑tap = one charge) · app killed mid‑payment → Pending row on return · transfer amount differs from the amount entered → credit what arrived · transfer from a third‑party name → hold for review · chargeback → negative balance, wallet limited to paying it off · offline → Fund disabled with "You are offline".

**Notifications:** "Wallet funded" P, I (exists in catalogue); add **"Payment pending"** I and **"Funding failed"** P, I.

---

## 10. Agency subscription — process flow

**What exists:** `Agency onboarding` (starts at "Agency approved — Done"), `Agency empty overview` (5‑step checklist), `Agency billing` (fees, invoices, method, "Before you are active"), `Agency payouts`, `Agency bounties`, `Admin agencies and stations` (approval card), admin Settings → Plans (has "Agency drone and fire drop service, per month").

**Gaps**
1. **No pre‑approval journey.** Nothing before "Agency approved": no public sign‑up, agency details form, document upload, "under review", "more information needed" or "rejected" screens (ADM‑1 is an MVP must).
2. **Three different setup checklists:** Onboarding (Approved → Stations → Officers → Payout), Empty overview (Approved → Fee paid → Station and head → Officers → Routing and bounty), Billing (Documents → Fee → Head identity). Merge into one (below).
3. **No plan or licence choice.** The PRD's "agency licence" and admin's "drone and fire drop service" plan are never offered to the agency. No upgrade, downgrade or cancel.
4. **No government payment path.** Agencies usually pay by invoice and bank transfer, not card. Need proforma invoice, PO number, TIN/VAT, and paying into a dedicated account with manual reconciliation.
5. **No recurring cycle screens:** invoice detail, reminders, overdue banner, card/transfer retry, receipts.
6. **Messaging cost has no payer.** CRM results show cost per channel, but agency SMS/WhatsApp usage isn't billed anywhere. Add it as a usage line or prepaid credits.
7. **No bounty pool funding flow** (States doc: "Pool too low — add funds before approving").
8. **No offboarding.**
9. **Admin side:** no agency billing view — fee overrides for pilot partners, credit notes, marking a transfer as paid, waiving with a second approver.

**Canonical lifecycle**

| # | Stage | Agency screens | Admin screens | Gate / rule |
|---|---|---|---|---|
| 1 | **Register** | Public "Register your agency": agency (from the 16‑agency list) or other, legal name, reg no, head office postcode, unit type. Contact person account: phone OTP, official email check, **2FA set‑up forced**. | — | Email on a government or agency domain flagged as stronger evidence. |
| 2 | **Documents** | Upload: establishment proof / registration, authorisation letter or MOU, head's ID, signatory letter. Draft saved. Submit. | — | Required list per agency type. |
| 3 | **Under review** | Status page with timeline: Submitted → In review → Decision; edit locked. | Agencies → Waiting → review card: check each document, **Approve / Ask for more / Reject** (reason). | ✏️ "Ask for more" loops back to 2 with the comment shown; reject is final with appeal contact. |
| 4 | **Choose plan** | Plan cards: **Base** (dashboard, [n] stations included) + add‑ons: extra stations, drone and fire drop programme, messaging credits. Summary: onboarding fee + first period, VAT. | Plans and fee schedule in Settings; per‑agency override. | Prices are config. |
| 5 | **Pay onboarding** | Paystack (card/transfer) **or** "Pay by invoice": download proforma, enter PO no., pay into a dedicated account → "Waiting for payment". | Finance marks a transfer as received if unmatched. | Webhook or finance confirmation only. |
| 6 | **Set up** (one checklist) | 1 Add stations and heads → 2 Set areas and routing → 3 Invite officers (≥ [n] verified per station) → 4 Link payout account (Paystack subaccount, signatory name match) → 5 Bounty rates and fund the pool (optional; required only to accept tips with bounties). | — | Routing goes live per station when its head + area + ≥1 on‑duty officer exist. |
| 7 | **Go live** | "You are live" confirmation; overview switches from checklist to dashboard. | Agency status → Live; appears in routing. | Reports in an uncovered area keep overflowing to the next agency until then (warning exists). |
| 8 | **Monthly cycle** | Invoice generated ([day]) — stations, inventory, messaging usage. Auto‑charge if a card is saved; else due in [n] days. Reminders −3 d, 0 d. Invoice detail, receipt PDF. | Invoices across agencies; credit note; waive (reason + second approver). | — |
| 9 | **Overdue** | Banner on every page: "New stations and equipment are on hold until you pay." Pay now. | Dunning list. | **Live dispatch never stops.** Restored the same day on payment. |
| 10 | **Change plan** | Add or remove an add‑on; upgrade now (prorated), downgrade at period end; confirm shows the new monthly amount. | Log. | — |
| 11 | **Offboard** | Request to leave: settle invoices, pay out the bounty pool and pending payouts, reassign or end officers, export records. | Approve; move routing; archive. | Audit and evidence records retained per policy. |

**Notifications to add:** documents received · more information needed · approved / rejected · payment received · invoice issued / due / overdue · add‑on activated · station went live.

---

## 11. Settings and pages — map per user type

Legend: ✅ drawn · ⚠️ partly drawn · ❌ missing. Every user type also gets the shared **My account** set: Profile, Security, Notifications, Appearance, Language, Help, Sign out (see §2).

### Citizen / household owner
| Settings page | Status | Contents |
|---|---|---|
| Profile and trust | ⚠️ | Add the rows in §2.1 |
| Edit profile | ❌ | Photo, name (locked after KYC — change via re‑verification), phone/email change with step‑up |
| Security | ✅ screen, ❌ entry | + 2FA wizard, sessions, devices, recovery codes, change PIN |
| Notifications | ❌ | Groups: Safety (locked on), Reports, Money (locked on), Tips, Learn, Marketing; per channel; quiet hours |
| Appearance | ✅ | Needs light version |
| Language | ❌ | English, Hausa, Yoruba, Igbo, Pidgin; voice language for statements |
| Discreet mode | ❌ | Neutral icon and name, silent UI, quick exit, test |
| Emergency contacts | ❌ | Up to 3; verify by SMS; what they receive; per‑type toggle |
| Saved places | ❌ | Home (verified), Work, Other; edit via postcode |
| Permissions | ❌ | Location (Always/While using), Notifications, Camera, Mic |
| Wallet settings | ❌ | Bank accounts, auto‑pay, limits shown |
| Household | ⚠️ | Members list, roles, invites, leave |
| Privacy and data | ❌ | Download my data, correction request, consent history, **delete account (blocked until settled)** |
| Help | ❌ | FAQ, contact support, replay tour, terms, privacy, app version |

### Officer
| Settings page | Status | Contents |
|---|---|---|
| Profile and rating | ✅ | Add Security, Documents, Duty, Notifications, Language, Help |
| Documents and badge | ❌ | Badge no., rank, expiry, renewal upload, status |
| Duty and shifts | ❌ | My roster, swap/leave request, status |
| Dispatch alerts | ❌ | Sound, vibration, volume override, repeat; cannot be turned off while on duty |
| Navigation | ❌ | Preferred maps app, voice guidance |
| Panic / officer help | ❌ | How it works, test mode, who is alerted |
| Security, Appearance, Language, Permissions, Help | ❌ | Shared; Location "Always" required on duty |

### Station head / dispatcher
| Page | Status | Notes |
|---|---|---|
| Station settings | ✅ | Profile, area, accept window and fallback, alerts, access |
| Access → manage people | ❌ | The Access card shows counts only; needs list, invite, role change, remove |
| Roster rules | ⚠️ | Minimum per shift, shift templates, leave policy — summarised on Roster, not editable |
| Outcome codes and close rules | ❌ | Which outcomes need a note or evidence |
| Station public profile | ❌ | Photo, description, rating, donations received |
| My account | ❌ | §2.3 |

### Agency admin
| Page | Status | Notes |
|---|---|---|
| Agency settings | ✅ | Profile, team access, alerts, privacy |
| Team access → manage people | ❌ | Invite exists; list/role change/remove/2FA status missing |
| Documents | ❌ | Registration docs, expiry, re‑submit (changing name or type triggers re‑approval) |
| Tip categories accepted | ❌ | Rewards doc: each agency chooses its categories |
| Payout shares | ⚠️ | On Payouts page; confirm editing + approval |
| Messaging | ❌ | Sender names, approvers, templates, credits |
| Billing and plan | ⚠️ | §10 |
| Integrations | ❌ | CAD/API keys (PRD open question), webhooks |
| Danger zone | ❌ | Pause agency, offboard |
| My account | ❌ | §2.3 |

### Platform admin
| Settings tab | Status | Notes |
|---|---|---|
| Plans, Routing, Trust and fines, Integrations, Roles | ✅ | Roles card has no add/edit |
| Money | ❌ | Wallet min/max, daily withdraw limit, hold days, first‑withdrawal delay, bounty fee %, donation fee %, agency fee schedule, dunning stage days |
| Incident types and outcomes | ❌ | Types, severities, outcome codes, cancel window, accept window defaults |
| Merge rules | ❌ | Radius, time window per type family, auto‑merge pairs |
| Tips and public issues routing | ❌ | Category → agency table |
| Notifications and messaging | ❌ | Templates, quiet hours, sender ID, WhatsApp templates, fallback order |
| Security policy | ❌ | Session timeouts, MFA enforcement, IP allowlist for staff, password rules, PIN lock rules |
| Data and retention | ❌ | Clip retention, incident hold, audit retention, data‑request queue |
| Legal documents | ❌ | Terms/privacy versions, re‑consent trigger |
| Languages and AI | ⚠️ | AI page exists; languages test status |
| System status | ❌ | Maintenance banner, provider status, feature flags |
| My account | ❌ | §2.3 |

### Technician (new role)
| Page | Status | Notes |
|---|---|---|
| Jobs (today / upcoming / done), Job detail, Checklist, Serial scan, Customer code, Close | ❌ | §3 T‑1 |
| Profile, Documents (ID, vetting), Security, Notifications, Help | ❌ | Vetting is required for camera access (Security doc) |
