"""Pivot from a domain to related domains. Version 1: shared nameservers only."""
import json
import sys


def pivot(domain: str) -> list[str]:
    # Placeholder: a real run would ask a passive-DNS source for domains on the same nameservers.
    return []


if __name__ == "__main__":
    print(json.dumps({"domain": sys.argv[1], "related": pivot(sys.argv[1])}))
