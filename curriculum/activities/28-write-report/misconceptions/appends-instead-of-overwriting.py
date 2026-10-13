with open("report.txt") as f:
    previous = f.read()

with open("report.txt", "w") as f:
    f.write(previous + "Items processed: 5\nAverage: 2.5\n")
