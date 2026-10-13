people = [("Sam", "9"), ("Ada", "41"), ("Bo", "35")]
people.sort(key=lambda person: int(person[1]))
sorted_people = people
