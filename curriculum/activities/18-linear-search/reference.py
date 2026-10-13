def search(items, target):
    for i in range(len(items)):
        if items[i] == target:
            return i
    return -1
