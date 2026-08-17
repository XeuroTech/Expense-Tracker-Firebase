/**
 * OTP email delivery via Resend (https://resend.com).
 *
 * Set secrets once, then redeploy functions that send OTP:
 *   firebase functions:secrets:set RESEND_API_KEY --project <id>
 *   firebase functions:secrets:set RESEND_FROM --project <id>
 *
 * RESEND_FROM examples:
 *   Testing:  Unity Finance <onboarding@resend.dev>
 *   Production: Unity Finance <noreply@yourdomain.com>  (domain verified in Resend)
 */

const { defineSecret } = require('firebase-functions/params');

const { logger, fail } = require('./common');

const RESEND_API_KEY = defineSecret('RESEND_API_KEY');
const RESEND_FROM = defineSecret('RESEND_FROM');

const RESEND_API_URL = 'https://api.resend.com/emails';

const OTP_SUBJECTS = {
    mfa_login: 'Your Expense Tracker sign-in verification code',
    mfa_security: 'Your Expense Tracker two-factor verification code',
};

const buildOtpText = (purpose, code, expiresMinutes) => {
    const introByPurpose = {
        mfa_login: 'Someone is signing in to your Expense Tracker account.',
        mfa_security: 'You requested a security verification for your Expense Tracker account.',
    };
    const intro = introByPurpose[purpose] || 'You requested a verification code for Expense Tracker.';

    return (
        `${intro}\n\n` +
        `Your verification code is: ${code}\n\n` +
        `This code expires in ${expiresMinutes} minutes. ` +
        'If you did not request this, you can safely ignore this email.'
    );
};

const buildOtpHtml = (purpose, code, expiresMinutes) => {
    const titleByPurpose = {
        mfa_login: 'Sign-in verification',
        mfa_security: 'Two-factor verification',
    };
    const title = titleByPurpose[purpose] || 'Verification code';

    return `<!DOCTYPE html>
<html>
<body style="font-family:Arial,sans-serif;line-height:1.5;color:#111;">
  <h2 style="margin-bottom:8px;">${title}</h2>
  <p style="color:#555;margin-bottom:4px;">Expense Tracker</p>
  <p>Your verification code is:</p>
  <p style="font-size:28px;font-weight:bold;letter-spacing:6px;margin:16px 0;">${code}</p>
  <p style="color:#555;">This code expires in ${expiresMinutes} minutes.</p>
  <p style="color:#555;">If you did not request this, you can safely ignore this email.</p>
</body>
</html>`;
};

/**
 * Sends a 6-digit OTP email through Resend.
 */
const sendOtpEmail = async ({ to, purpose, code, expiresMinutes = 5 }) => {
    const apiKey = RESEND_API_KEY.value();
    if (!apiKey) throw fail('RESEND_NOT_CONFIGURED', 501);

    const from = RESEND_FROM.value() || 'Expense Tracker <onboarding@resend.dev>';
    const subject = OTP_SUBJECTS[purpose] || 'Your Expense Tracker verification code';
    const text = buildOtpText(purpose, code, expiresMinutes);
    const html = buildOtpHtml(purpose, code, expiresMinutes);

    const response = await fetch(RESEND_API_URL, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({ from, to: [to], subject, text, html }),
    });

    if (!response.ok) {
        logger.error('Resend OTP email failed', {
            purpose,
            status: response.status,
            body: await response.text().catch(() => ''),
        });
        throw fail('OTP_SEND_FAILED', 500);
    }
};

module.exports = {
    sendOtpEmail,
    RESEND_API_KEY,
    RESEND_FROM,
};
