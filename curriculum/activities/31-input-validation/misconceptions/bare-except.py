while True:
    try:
        n = int(input("Enter a number: "))
        break
    except:
        print("That was not a number. Try again.")

print("You entered:", n)
