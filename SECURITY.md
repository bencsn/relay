# Security policy

## Reporting

Do not open public issues for suspected vulnerabilities or include live credentials/prompt data in a report.

Use GitHub's private vulnerability reporting for this repository (`Security` → `Report a vulnerability`). If that feature is unavailable, contact the maintainer through the private contact listed on the GitHub profile and request a secure reporting channel.

Include affected version/commit, impact, reproduction using synthetic data, and any suggested mitigation. Expect acknowledgement within three business days. No bounty is promised.

## Supported versions

Until the first stable release, only the latest commit on `main` and latest tagged prerelease receive security fixes. Production operators must track releases and dependency alerts.

## Scope notes

A public donor's ability to see the plaintext prompt it processes is a documented product limitation, not a vulnerability. Unauthorized cross-account access, credential exposure, SSRF, authentication bypass, lease/result integrity failures, prompt leakage through logs, and supply-chain compromise are in scope.
