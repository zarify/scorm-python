import csv

with open("data.csv") as f:
    reader = csv.reader(f)
    next(reader)
    scores = [float(row[1]) for row in reader]

average = sum(scores) / len(scores)

with open("result.csv", "w", newline="") as f:
    writer = csv.writer(f)
    writer.writerow(["average"])
    writer.writerow([average])

print("Wrote result.csv")
