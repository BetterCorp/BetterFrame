/**
 * Auth page templates: setup, login, TOTP, recovery.
 */
import { js } from "jsx-htmx";
import { MinimalLayout } from "./layout.js";

// ---- Setup ------------------------------------------------------------------

export function SetupPage(props: { error?: string; username?: string }) {
  return (
    <MinimalLayout
      title="Initial Setup"
      flash={props.error ? { type: "error", message: props.error } : undefined}
    >
      <p style="color:#666; margin-bottom:1.25rem">
        Create your admin account to get started.
      </p>
      <form method="post" action="/setup">
        <div class="form-group">
          <label for="username">Username</label>
          <input
            id="username"
            name="username"
            type="text"
            class="form-input"
            required
            minlength="3"
            maxlength="64"
            pattern="[a-zA-Z0-9_-]+"
            value={props.username ?? ""}
            autocomplete="username"
          />
          <div class="form-hint">3–64 characters. Letters, digits, underscore, hyphen.</div>
        </div>
        <div class="form-group">
          <label for="password">Password</label>
          <input
            id="password"
            name="password"
            type="password"
            class="form-input"
            required
            minlength="12"
            autocomplete="new-password"
          />
          <div class="form-hint">At least 12 characters.</div>
        </div>
        <button type="submit" class="btn btn-primary btn-block">Create Admin Account</button>
      </form>
    </MinimalLayout>
  );
}

// ---- Login ------------------------------------------------------------------

export function LoginPage(props: { error?: string; username?: string; welcome?: boolean }) {
  return (
    <MinimalLayout
      title="Sign In"
      flash={
        props.error
          ? { type: "error", message: props.error }
          : props.welcome
            ? { type: "success", message: "Admin account created. Sign in to continue." }
            : undefined
      }
    >
      <form method="post" action="/auth/login">
        <div class="form-group">
          <label for="username">Username</label>
          <input
            id="username"
            name="username"
            type="text"
            class="form-input"
            required
            value={props.username ?? ""}
            autocomplete="username"
          />
        </div>
        <div class="form-group">
          <label for="password">Password</label>
          <input
            id="password"
            name="password"
            type="password"
            class="form-input"
            required
            autocomplete="current-password"
          />
        </div>
        <button type="submit" class="btn btn-primary btn-block">Sign In</button>
      </form>
    </MinimalLayout>
  );
}

// ---- TOTP -------------------------------------------------------------------

export function TotpPage(props: { error?: string }) {
  return (
    <MinimalLayout
      title="Two-Factor Authentication"
      flash={props.error ? { type: "error", message: props.error } : undefined}
    >
      <p style="color:#666; margin-bottom:1rem">
        Enter the 6-digit code from your authenticator app.
      </p>
      <form method="post" action="/auth/totp">
        <div class="form-group">
          <label for="code">Code</label>
          <input
            id="code"
            name="code"
            type="text"
            class="form-input"
            required
            maxlength="6"
            pattern="[0-9]{6}"
            autocomplete="one-time-code"
            inputmode="numeric"
            style="text-align:center; font-size:1.5rem; letter-spacing:0.3rem"
          />
        </div>
        <button type="submit" class="btn btn-primary btn-block">Verify</button>
      </form>
      <p style="text-align:center; margin-top:1rem">
        <a href="/auth/recovery">Use a recovery code</a>
      </p>
    </MinimalLayout>
  );
}

// ---- Recovery ---------------------------------------------------------------

export function RecoveryPage(props: { error?: string }) {
  return (
    <MinimalLayout
      title="Recovery Code"
      flash={props.error ? { type: "error", message: props.error } : undefined}
    >
      <p style="color:#666; margin-bottom:1rem">
        Enter one of your recovery codes. Each code can only be used once.
      </p>
      <form method="post" action="/auth/recovery">
        <div class="form-group">
          <label for="code">Recovery Code</label>
          <input
            id="code"
            name="code"
            type="text"
            class="form-input"
            required
            maxlength="10"
            style="text-align:center; font-size:1.1rem; letter-spacing:0.15rem; text-transform:uppercase"
          />
        </div>
        <button type="submit" class="btn btn-primary btn-block">Verify</button>
      </form>
      <p style="text-align:center; margin-top:1rem">
        <a href="/auth/totp">Back to authenticator code</a>
      </p>
    </MinimalLayout>
  );
}
