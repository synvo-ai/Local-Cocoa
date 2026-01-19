import urllib.request
import json
import sys

API_URL = "http://127.0.0.1:8890/qa/stream"
API_KEY = "sk-local-s-EDGNt2z_bmxPnvkQ__eNlMtcyswJnCSBacWOOr4dQ"

payload = {
    "query": "How many patents did NTU file in 2022 and 2023",
    "mode": "qa",
    "history": [],
    "limit": 10,
    "search_mode": "auto"
}

req = urllib.request.Request(API_URL)
req.add_header('Content-Type', 'application/json')
req.add_header('X-API-Key', API_KEY)

jsondata = json.dumps(payload).encode('utf-8')
req.add_header('Content-Length', len(jsondata))

print(f"Sending request to {API_URL}...")
try:
    response = urllib.request.urlopen(req, jsondata)
    for line in response:
        decoded_line = line.decode('utf-8').strip()
        if not decoded_line:
            continue
            
        try:
            # Lines are usually just JSON objects in NDJSON format for this API?
            # Or SSE? "stream_answer" usually yields JSON strings followed by newline.
            # qa.py yields `json.dumps(...) + "\n"`
            data = json.loads(decoded_line)
            
            if data.get("type") == "thinking_step":
                step = data["data"]
                # print(f"🧠 [Step: {step['type']}] {step['title']} (Status: {step['status']})")
                if "subQueryAnswer" in step:
                    print(f"   ✅ {step['title']} -> Answer: {step['subQueryAnswer']}")
                if "hits" in step:
                    indices = [h.get("metadata", {}).get("index", "?") for h in step.get("hits", [])]
                    print(f"   📊 Chunk Indices: {indices}")
            
            elif data.get("type") == "hits":
                # Show chunk IDs and indices when hits are emitted
                for h in data["data"]:
                    idx = h.get("metadata", {}).get("index", "?")
                    chunk_id = h.get("chunkId") or h.get("chunk_id") or "?"
                    print(f"    Hit: idx={idx} chunkId={chunk_id[:30] if chunk_id != '?' else '?'}...")
            
            elif data.get("type") == "chunk_analysis":
                pass

            elif data.get("type") == "token":
                sys.stdout.write(data["data"])
                sys.stdout.flush()
                
            elif data.get("type") == "error":
                print(f"❌ Error: {data['data']}")

        except json.JSONDecodeError:
            print(f"Raw output: {decoded_line}")
            
    print("\n\nDone.")
except Exception as e:
    print(f"Request failed: {e}")
