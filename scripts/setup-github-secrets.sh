#!/bin/bash
set -euo pipefail

# Check if gh is authenticated
if ! gh auth status &>/dev/null; then
  echo "Error: You are not logged in to GitHub CLI ('gh'). Please run 'gh auth login' first."
  exit 1
fi

echo "============================================================"
echo "          Tauri macOS Code Signing & Notarization"
echo "               GitHub Secrets Setup Helper"
echo "============================================================"
echo ""
echo "This script will help you configure the GitHub Secrets needed"
echo "for macOS code signing and notarization."
echo ""

# 1. APPLE_CERTIFICATE (.p12 file)
read -rp "Enter the path to your exported Apple .p12 certificate file: " p12_path
# Expand tilde
p12_path="${p12_path/#\~/$HOME}"
if [ ! -f "$p12_path" ]; then
  echo "Error: File not found at $p12_path"
  exit 1
fi

read -rsp "Enter the password for this .p12 certificate: " p12_password
echo ""

# 2. APPLE_SIGNING_IDENTITY
echo ""
echo "Checking local signing identities..."
echo "You can find your signing identity name (e.g., 'Developer ID Application: Company (TeamID)') below:"
security find-identity -v -p codesigning || true
echo ""
read -rp "Enter the exact name of your Developer ID Application identity: " signing_identity

# 3. Notarization method
echo ""
echo "Choose your Notarization method:"
echo "1) App Store Connect API Key (Recommended for teams/organizations)"
echo "2) Apple ID & App-Specific Password (Simpler for individual developers)"
read -rp "Select option (1 or 2): " notarization_option

# Setup variables based on choice
if [ "$notarization_option" = "1" ]; then
  read -rp "Enter APPLE_API_KEY (Key ID, e.g. 2X94A8B3C4): " api_key
  read -rp "Enter APPLE_API_ISSUER (Issuer ID, UUID): " api_issuer
  read -rp "Enter the path to your .p8 private key file: " p8_path
  p8_path="${p8_path/#\~/$HOME}"
  if [ ! -f "$p8_path" ]; then
    echo "Error: File not found at $p8_path"
    exit 1
  fi
  api_key_content=$(cat "$p8_path")
elif [ "$notarization_option" = "2" ]; then
  read -rp "Enter your APPLE_ID (Apple ID email): " apple_id
  read -rsp "Enter your APPLE_PASSWORD (App-Specific Password): " apple_password
  echo ""
  read -rp "Enter your APPLE_TEAM_ID (10-character Team ID): " apple_team_id
else
  echo "Invalid option."
  exit 1
fi

echo ""
echo "Encoding certificate file to base64..."
base64_cert=$(openssl base64 -A -in "$p12_path")

echo "Setting GitHub Secrets..."

# Common secrets
gh secret set APPLE_CERTIFICATE --body "$base64_cert"
gh secret set APPLE_CERTIFICATE_PASSWORD --body "$p12_password"
gh secret set APPLE_SIGNING_IDENTITY --body "$signing_identity"

if [ "$notarization_option" = "1" ]; then
  gh secret set APPLE_API_KEY --body "$api_key"
  gh secret set APPLE_API_ISSUER --body "$api_issuer"
  gh secret set APPLE_API_KEY_CONTENT --body "$api_key_content"
  
  # Remove Apple ID secrets if they exist to avoid confusion
  gh secret remove APPLE_ID 2>/dev/null || true
  gh secret remove APPLE_PASSWORD 2>/dev/null || true
  gh secret remove APPLE_TEAM_ID 2>/dev/null || true
else
  gh secret set APPLE_ID --body "$apple_id"
  gh secret set APPLE_PASSWORD --body "$apple_password"
  gh secret set APPLE_TEAM_ID --body "$apple_team_id"
  
  # Remove API secrets if they exist to avoid confusion
  gh secret remove APPLE_API_KEY 2>/dev/null || true
  gh secret remove APPLE_API_ISSUER 2>/dev/null || true
  gh secret remove APPLE_API_KEY_CONTENT 2>/dev/null || true
fi

echo ""
echo "============================================================"
echo "GitHub Secrets set successfully!"
echo "Your release workflow is now configured to codesign and notarize"
echo "the macOS application."
echo "============================================================"
