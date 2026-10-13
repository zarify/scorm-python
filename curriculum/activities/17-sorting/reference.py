people = [("Sam", "9"), ("Ada", "41"), ("Bo", "35")]
sorted_people = sorted(people, key=lambda person: int(person[1]))
