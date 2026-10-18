-- Forgotten withdrawal PIN: reset with a code sent by SMS to the account's phone.
alter table otp_challenges drop constraint otp_challenges_purpose_check;
alter table otp_challenges add constraint otp_challenges_purpose_check check (purpose in ('sign_in', 'step_up', 'change_phone', 'pin_reset'));

-- After a reset, withdrawals wait 24 hours (protects against a stolen SIM).
alter table users add column pin_reset_at timestamptz;
