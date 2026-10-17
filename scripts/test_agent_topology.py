import os
import sys
from openai import OpenAI
from dotenv import load_dotenv

# Load environment variables from .env file
load_dotenv()

# Point to an alternative OpenAI-compatible gateway/provider (e.g., OpenRouter, local vLLM, etc.)
client = OpenAI(
    api_key=os.environ.get("API_KEY"),
    base_url=os.environ.get("BASE_URL")
)

RAW_DOM_LOGS = """
<html>
  <body>
    <form action="/search" method="GET">
      <input id="search" name="q" type="text" value="<script>alert(1)</script>" />
      <button type="submit">Search</button>
    </form>
    <div id="results">Reflected Output: &lt;script&gt;alert(1)&lt;/script&gt;</div>
  </body>
</html>
"""

def run_parser(raw_html):
    print("[Parser] Analyzing raw DOM...")
    response = client.chat.completions.create(
        model="gpt-oss-20b",
        messages=[
            {"role": "system", "content": "You are a fast DOM parsing subagent."},
            {"role": "user", "content": f"Extract form inputs and IDs from:\n{raw_html}"}
        ],
        max_tokens=500
    )
    return response.choices[0].message.content

def run_orchestrator(dom_summary):
    print("[Orchestrator] Generating hypothesis...")
    response = client.chat.completions.create(
        model="gpt-oss-20b",
        messages=[
            {"role": "system", "content": "You are a lead penetration testing strategist."},
            {"role": "user", "content": f"Parsed DOM:\n{dom_summary}\nGenerate an XSS test hypothesis."}
        ],
        max_tokens=500
    )
    return response.choices[0].message.content

def run_evaluator(hypothesis, dom_summary):
    print("[Evaluator] Validating findings...")
    response = client.chat.completions.create(
        model="gpt-oss-20b",
        messages=[
            {"role": "system", "content": "Return strict JSON with keys: vulnerable (boolean), confidence (string), reason (string)."},
            {"role": "user", "content": f"Hypothesis: {hypothesis}\nData: {dom_summary}"}
        ],
        response_format={"type": "json_object"},
        max_tokens=500
    )
    print(f"Evaluation: {response.choices[0].message.content}\n")
    return response.choices[0].message.content

if __name__ == "__main__":
    dom_data = run_parser(RAW_DOM_LOGS)
    hyp = run_orchestrator(dom_data)
    run_evaluator(hyp, dom_data)