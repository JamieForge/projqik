# Turning on real Apple signing for ProjQik

This is the reference for the GitHub Actions signing pipeline. As of this update, the actual
certificate has already been generated and installed — this doc mainly documents what the 5
GitHub secrets are and where they came from, for future reference.

## The 5 required GitHub secrets

Add these under your repo's **Settings → Secrets and variables → Actions**, using these exact
names (the workflow file reads them by these names precisely):

| Secret name | Value |
|---|---|
| `APPLE_CERTIFICATE_P12_BASE64` | The base64-encoded `.p12` certificate export |
| `APPLE_CERTIFICATE_PASSWORD` | The password set when exporting the `.p12` |
| `APPLE_ID` | The Apple ID email on the developer account (tcmystery@msn.com) |
| `APPLE_APP_SPECIFIC_PASSWORD` | Generated at appleid.apple.com → Sign-In and Security → App-Specific Passwords |
| `APPLE_TEAM_ID` | `463G38UCAX` (Freedom Forge AI LLC) |

## How the certificate was actually generated (for future reference)

The Keychain Access GUI proved unreliable for this specific process — Certificate Assistant
repeatedly failed, and the GUI's key/certificate pairing was hard to verify directly. The working
path ended up being:

1. Generate the private key directly via Terminal:
   ```
   openssl genrsa -out ~/Desktop/ProjQik_private.key 2048
   ```
2. Generate the CSR from that exact key:
   ```
   openssl req -new -key ~/Desktop/ProjQik_private.key -out ~/Desktop/ProjQik_request.certSigningRequest -subj "/emailAddress=YOUR_APPLE_ID/CN=Freedom Forge AI/C=US"
   ```
3. Upload that CSR at developer.apple.com/account/resources/certificates/list → **+** →
   **Developer ID Application** → the **G2** intermediary → download the resulting certificate.
4. Import both pieces explicitly into the keychain:
   ```
   security import ~/Desktop/ProjQik_private.key -k ~/Library/Keychains/login.keychain-db
   security import ~/Desktop/developerID_application.cer -k ~/Library/Keychains/login.keychain-db
   ```
5. Verify: `security find-identity -v -p codesigning` should show **1 valid identity**.
6. Export as `.p12` directly via Terminal (bypassing the GUI export dialog that failed to prompt
   for a password previously):
   ```
   security export -k ~/Library/Keychains/login.keychain-db -t identities -f pkcs12 -o ~/Desktop/ProjQik_signing.p12 -P YOUR_CHOSEN_PASSWORD
   ```
7. Convert to base64 for the GitHub secret:
   ```
   base64 -i ~/Desktop/ProjQik_signing.p12 | pbcopy
   ```

**If this ever needs to be redone** (certificate renewal, new machine, etc.), the Terminal-based
path above is the proven-reliable one — worth using it directly rather than starting with
Keychain Access's Certificate Assistant again.

## How to tell it actually worked

In a finished GitHub Actions run, open the **"Report signing status"** step. You should see:

```
Authority=Developer ID Application: Freedom Forge AI LLC (463G38UCAX)
```

And the Gatekeeper check near the bottom should say `accepted`. A build downloaded from a run
showing that should install with a plain double-click — zero warnings, no `xattr` workaround,
for anyone.
