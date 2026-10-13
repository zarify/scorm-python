import csv

with open("data.csv") as f:
    reader = csv.reader(f)
    header = next(reader)
    kept = list(reader)

with open("result.csv", "w", newline="") as f:
    writer = csv.writer(f)
    writer.writerow(header)
    writer.writerows(kept)
