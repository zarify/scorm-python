raw = open("config.json").read()
name = input("Setting name?")
value = raw.split('"' + name + '": "')[1].split('"')[0]
print(value)
