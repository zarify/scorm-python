names = ["Anna", "Sam", "Grace", "Simon", "Tina"]
first = ""
i = 0
while i < len(names):
    if names[i].startswith("S"):
        first = names[i]
        break
    i += 1
