import json

with open("config.json") as f:
    config = json.load(f)

name = input("Setting name?")
value = config[name]
print(value)
