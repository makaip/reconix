import argparse
import json
from z3 import *

def solve_constraints(max_len: int, must_contain: str, pattern: str = None):
    s = Solver()
    user_input = String('user_input')
    
    # Core length constraints
    s.add(Length(user_input) <= max_len)
    s.add(Length(user_input) > 0)
    
    # Substring / payload inclusion
    if must_contain:
        payload = Const('payload', StringSort())
        s.add(payload == must_contain)
        s.add(Contains(user_input, payload))
        
    # Optional regex pattern matching
    if pattern:
        try:
            re_pattern = Re(pattern)
            s.add(InRe(user_input, re_pattern))
        except Exception as e:
            return {"status": "error", "reason": f"Invalid regex pattern for Z3: {str(e)}"}
        
    if s.check() == sat:
        m = s.model()
        result = m.eval(user_input).as_string()
        return {"status": "success", "generated_input": result}
    else:
        return {"status": "unsat", "reason": "No string satisfies the given constraints."}

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Z3 Constraint Solver for Web Inputs")
    parser.add_argument("--max-len", type=int, default=50, help="Maximum allowed length")
    parser.add_argument("--contain", type=str, default="", help="Substring that must be present")
    parser.add_argument("--pattern", type=str, default=None, help="Regex pattern restriction")
    
    args = parser.parse_args()
    
    output = solve_constraints(args.max_len, args.contain, args.pattern)
    print(json.dumps(output))