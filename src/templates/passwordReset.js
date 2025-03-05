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
            .profile-logo {
              width: 60px;
              height: 60px;
              border-radius: 50%;
              margin-right: 10px;
              object-fit: cover;
            }
            .email-header {
              display: flex;
              align-items: center;
              padding: 20px;
              background-color: #f8f9fa;
              border-bottom: 1px solid #e9ecef;
            }
            .sender-info {
              display: flex;
              flex-direction: column;
            }
            .sender-name {
              font-weight: bold;
              font-size: 16px;
            }
            .sender-email {
              color: #666;
              font-size: 14px;
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
              border-top: 1px solid #e9ecef;
            }
          </style>
        </head>
        <body>
          <div class="email-container">
            <div class="email-header">
              <img src="https://boomlify.com/vite.svg" alt="Boomlify" class="profile-logo">
              <div class="sender-info">
                <span class="sender-name">Boomlify Support</span>
                <span class="sender-email">support@boomlify.com</span>
              </div>
            </div>
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
