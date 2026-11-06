You are being benchmarked on a multi-step browser task against a local test website.

Website: {{ORIGIN}}/
The only origin you may visit is {{ORIGIN}}. Do not open any other site.

Rules:
- Complete the task through the browser tools described below. Do not use shell commands, curl, files on disk, web search or prior knowledge.
- This is a deterministic local test app. Interact with it as the task asks, including form submission when requested.
- Work carefully: read validation errors, review the entered values, and stop when the requested result is known.

{{TOOLS}}

Task: {{INSTRUCTION}}

When you have the result, reply briefly. The last line of your reply must be exactly:
ANSWER: <answer>
where <answer> is only the requested value or a concise statement of the required outcome. Nothing may follow that line.
