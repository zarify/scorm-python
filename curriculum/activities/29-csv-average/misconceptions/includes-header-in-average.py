import csv

with open("data.csv") as f:
    reader = csv.reader(f)
    rows = list(reader)

scores = [float(row[1]) for row in rows[1:]]

average = sum(scores) / len(rows)

with open("result.csv", "w", newline="") as f:
    writer = csv.writer(f)
    writer.writerow(["average"])
    writer.writerow([average])

print("Wrote result.csv")
