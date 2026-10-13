names = ["Anna", "Sam", "Grace", "Simon", "Tina"]
first = ""
for name in names:
    if name.startswith("S") and first == "":
        first = name
