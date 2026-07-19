# Privacy and acceptable workloads

Relay provides pseudonymity between participants, not anonymity from Relay.

The donor receives the inference request needed to perform work plus opaque job/lease identifiers. It does not receive consumer account identity, API key, email, IP address, or billing information. The consumer receives a virtual model and result, not donor identity or credentials. Relay knows both authenticated parties and routes the payload.

The selected donor necessarily processes prompt plaintext and can technically inspect it. Do not send:

- passwords, API keys, signing material, cookies, or access tokens;
- confidential/private repositories or proprietary source code;
- personal, health, financial, regulated, export-controlled, or legally privileged data;
- content whose processing by an unknown third party is prohibited.

Recommended public-pool workloads are public text/code generation, summarization of already-public material, demos, evaluations, and disposable experiments.

Results are retained for seven days by default. Consumers may use `DELETE /v1/jobs/{id}` to erase the stored canonical prompt/result early. Expired retention clears payload/result data. Database backups may retain historical blocks according to the operator's published backup policy; production operators must document that policy and deletion limitations.

Future confidential use should use explicitly trusted organization pools and approved machines. Ordinary end-to-end encryption cannot hide a prompt from the machine that must perform ordinary inference.
