export const getPasswordResetEmailTemplate = (resetLink) => ({
    subject: 'Reset Your Password - Boomlify',
    html: `
      <!DOCTYPE html>
      <html>
        <head>
          <style>
            .email-container {
              max-width: 600px;
              margin: 0 auto;
              font-family: Arial, sans-serif;
              color: #333333;
            }
            .header {
              background-color: #4A90E2;
              color: white;
              padding: 20px;
              text-align: center;
            }
            .profile-logo {
              width: 40px;
              height: 40px;
              border-radius: 50%;
              background-color: #4A90E2;
              display: flex;
              align-items: center;
              justify-content: center;
              overflow: hidden;
            }
            .profile-logo img {
              width: 100%;
              height: 100%;
              object-fit: cover;
            }
            .content {
              padding: 20px;
              line-height: 1.5;
            }
            .button {
              background-color: #4A90E2;
              color: white;
              padding: 12px 24px;
              text-decoration: none;
              border-radius: 4px;
              display: inline-block;
              margin: 20px 0;
            }
            .footer {
              text-align: center;
              padding: 20px;
              font-size: 12px;
              color: #666666;
            }
          </style>
        </head>
        <body>
          <div class="email-container">
            <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom: 20px;">
              <tr>
                <td width="40">
                  <div class="profile-logo">
                    <img src="https://boomlify.com/logo.png" alt="B">
                  </div>
                </td>
                <td style="padding-left: 10px;">
                  <div style="font-weight: bold;">Boomlify Support</div>
                  <div style="color: #666; font-size: 13px;">support@boomlify.com</div>
                </td>
              </tr>
            </table>
            <div class="content">
              <p>Hello,</p>
              <p>We received a request to reset your password. Click the button below to create a new password:</p>
              <p style="text-align: center;">
                <a href="${resetLink}" class="button">Reset Password</a>
              </p>
              <p>This link will expire in 1 hour for security reasons.</p>
              <p>If you didn't request this password reset, please ignore this email or contact support if you have concerns.</p>
              <p>Best regards,<br>The Boomlify Team</p>
            </div>
            <div class="footer">
              <p>This is an automated message, please do not reply to this email.</p>
              <p>Boomlify - Secure Temporary Email Service</p>
            </div>
          </div>
        </body>
      </html>
    `
  });
