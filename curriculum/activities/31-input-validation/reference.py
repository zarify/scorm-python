while True:
    try:
        n = int(input("Enter a number: "))
        break
    except ValueError:
        print("That was not a number. Try again.")

print("You entered:", n)
