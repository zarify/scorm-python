import random

counts = {}
for _ in range(1000):
    random.seed(0)
    roll = random.randint(1, 6)
    counts[roll] = counts.get(roll, 0) + 1

sixes = counts.get(6, 0)
print(sixes)
